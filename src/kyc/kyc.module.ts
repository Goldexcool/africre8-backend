import { Body, ConflictException, Controller, Get, HttpException, HttpStatus, Inject, Injectable, Logger, Module, Post, ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from '../common/auth.decorators.js';
import { ErrorCode } from '../common/errors.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** What the provider said about a NIN and a selfie. `unavailable` means we could not get an answer (never held against the person). */
export type KycResult = { outcome: 'match' | 'no_match' | 'not_found' | 'unavailable'; confidence?: number };

export interface KycProvider {
  readonly name: string;
  verifyNin(input: { nin: string; selfieBase64: string }): Promise<KycResult>;
}

const MIN_CONFIDENCE = () => Number(process.env.KYC_MIN_CONFIDENCE ?? 90);

/**
 * Dojah (Nigerian KYC). The call is made from the server only: the secret key never reaches the app. Dojah matches the
 * selfie to the photo on the NIN record and answers with a confidence value; at or above the threshold it is a match.
 * Sandbox: https://sandbox.dojah.io, test NIN 70123456789. Docs: https://docs.dojah.io
 */
export class DojahProvider implements KycProvider {
  readonly name = 'dojah';
  private readonly log = new Logger('Dojah');

  async verifyNin({ nin, selfieBase64 }: { nin: string; selfieBase64: string }): Promise<KycResult> {
    const base = (process.env.DOJAH_BASE_URL ?? 'https://sandbox.dojah.io').replace(/\/$/, '');
    if (!process.env.DOJAH_APP_ID || !process.env.DOJAH_SECRET_KEY) {
      this.log.error('DOJAH_APP_ID or DOJAH_SECRET_KEY is not set');
      return { outcome: 'unavailable' };
    }
    let res: Response;
    try {
      res = await fetch(`${base}/api/v1/kyc/nin/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', AppId: process.env.DOJAH_APP_ID, Authorization: process.env.DOJAH_SECRET_KEY },
        body: JSON.stringify({ nin, selfie_image: selfieBase64 }),
        signal: AbortSignal.timeout(25_000),
      });
    } catch (e) {
      this.log.warn(`request failed: ${(e as Error).message}`);
      return { outcome: 'unavailable' };
    }
    const body = (await res.json().catch(() => ({}))) as { entity?: { selfie_verification?: { confidence_value?: number; match?: boolean } }; error?: string };
    if (res.status === 400 || res.status === 404 || res.status === 422) return { outcome: 'not_found' }; // the NIN (or the image) was not accepted
    if (!res.ok) {
      this.log.warn(`HTTP ${res.status}: ${String(body.error ?? '').slice(0, 120)}`); // 401 here means the AppId or secret is wrong
      return { outcome: 'unavailable' };
    }
    const v = body.entity?.selfie_verification;
    if (!v || typeof v.confidence_value !== 'number') return { outcome: 'unavailable' };
    return { outcome: v.match === true && v.confidence_value >= MIN_CONFIDENCE() ? 'match' : 'no_match', confidence: v.confidence_value };
  }
}

/** For local work and tests: no network. NIN 70123456789 matches (the same test NIN Dojah's sandbox uses). */
export class MockKycProvider implements KycProvider {
  readonly name = 'mock';
  async verifyNin({ nin }: { nin: string }): Promise<KycResult> {
    if (nin === '70123456789') return { outcome: 'match', confidence: 99 };
    if (nin === '11111111111') return { outcome: 'no_match', confidence: 41 };
    if (nin === '00000000000') return { outcome: 'unavailable' };
    return { outcome: 'not_found' };
  }
}

export const KYC_PROVIDER = Symbol('KYC_PROVIDER');

const submitSchema = z.object({
  nin: z.string().regex(/^\d{11}$/, 'A NIN has 11 digits.'),
  /** The selfie as base64 (a JPEG or PNG), with or without the data: prefix. */
  selfie: z.string().min(100, 'Take a selfie first.').max(4_000_000, 'That photo is too large. Take it again.'),
});

const MAX_ATTEMPTS = 3;
const WINDOW_MS = 24 * 3600_000;

@Injectable()
export class KycService {
  private readonly log = new Logger(KycService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Inject(KYC_PROVIDER) private readonly provider: KycProvider,
  ) {}

  /** The ID number is never stored: a keyed hash lets us notice the same ID on two accounts without keeping it. */
  private hash(nin: string) {
    return createHmac('sha256', process.env.JWT_ACCESS_SECRET ?? 'dev').update(`nin:${nin}`).digest('hex');
  }

  async status(userId: string) {
    const [user, latest, recent] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { verificationStatus: true } }),
      this.prisma.kycVerification.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { status: true, failureReason: true, createdAt: true } }),
      this.prisma.kycVerification.count({ where: { userId, status: 'FAILED', createdAt: { gt: new Date(Date.now() - WINDOW_MS) } } }),
    ]);
    return { status: user.verificationStatus, latest, attemptsLeft: Math.max(0, MAX_ATTEMPTS - recent) };
  }

  async submit(userId: string, input: z.infer<typeof submitSchema>) {
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { verificationStatus: true } });
    if (me.verificationStatus === 'VERIFIED') throw new ConflictException('You are already verified.');
    const failed = await this.prisma.kycVerification.count({ where: { userId, status: 'FAILED', createdAt: { gt: new Date(Date.now() - WINDOW_MS) } } });
    if (failed >= MAX_ATTEMPTS) throw new HttpException({ message: 'Too many attempts today. Please try again tomorrow, or contact support.', code: ErrorCode.RateLimited }, HttpStatus.TOO_MANY_REQUESTS);

    const selfie = input.selfie.replace(/^data:image\/\w+;base64,/, '');
    if (!selfie.startsWith('/9j/') && !selfie.startsWith('iVBOR')) throw new ConflictException('Use a JPEG or PNG photo.');
    const idHash = this.hash(input.nin);
    const base = { userId, provider: this.provider.name, idType: 'NIN', idLast4: input.nin.slice(-4), idHash };

    const taken = await this.prisma.kycVerification.findFirst({ where: { idHash, status: 'VERIFIED', userId: { not: userId } }, select: { id: true } });
    if (taken) {
      await this.prisma.kycVerification.create({ data: { ...base, status: 'FAILED', failureReason: 'This ID is already linked to another account.' } });
      throw new ConflictException('This ID is already linked to another account. If that is a mistake, contact support.');
    }

    const result = await this.provider.verifyNin({ nin: input.nin, selfieBase64: selfie });
    if (result.outcome === 'unavailable') throw new ServiceUnavailableException('Verification is not available right now. Please try again in a few minutes.'); // not counted against the person
    if (result.outcome !== 'match') {
      const failureReason = result.outcome === 'not_found' ? 'We could not find that NIN. Check the number and try again.' : 'The selfie did not match the ID. Take it again in good light, facing the camera.';
      await this.prisma.kycVerification.create({ data: { ...base, status: 'FAILED', confidence: result.confidence, failureReason } });
      return { ...(await this.status(userId)), passed: false, message: failureReason };
    }
    try {
      await this.prisma.$transaction([
        this.prisma.kycVerification.create({ data: { ...base, status: 'VERIFIED', confidence: result.confidence } }),
        this.prisma.user.update({ where: { id: userId }, data: { verificationStatus: 'VERIFIED' } }),
        this.prisma.auditLog.create({ data: { actorId: userId, action: 'kyc.verified', entity: 'User', entityId: userId, meta: { provider: this.provider.name, confidence: result.confidence ?? null } } }),
      ]);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('This ID is already linked to another account. If that is a mistake, contact support.');
      throw e;
    }
    await this.notifications.notify(userId, { kind: 'account', title: 'You are verified', body: 'Your identity was confirmed. Your profile now shows the verified badge.', linkTo: '/verification' });
    this.log.log(`verified ${userId}`);
    return { ...(await this.status(userId)), passed: true, message: 'You are verified.' };
  }
}

@Roles('BRAND', 'CREATOR')
@Controller('verification/kyc')
class KycController {
  constructor(private readonly kyc: KycService) {}

  @Get() status(@CurrentUser() u: AuthUser) { return this.kyc.status(u.id); }
  @Post() submit(@CurrentUser() u: AuthUser, @Body(new ZodPipe(submitSchema)) b: z.infer<typeof submitSchema>) { return this.kyc.submit(u.id, b); }
}

@Module({
  controllers: [KycController],
  providers: [
    { provide: KYC_PROVIDER, useFactory: (): KycProvider => (process.env.KYC_PROVIDER === 'dojah' ? new DojahProvider() : new MockKycProvider()) },
    KycService,
  ],
  exports: [KycService],
})
export class KycModule {}
