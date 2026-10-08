import { BadRequestException, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import type { OtpPurpose } from '../generated/prisma/client.js';
import { ErrorCode } from '../common/errors.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;
export const CODE_LENGTH = 4; // matches the mobile CodeInput

const COPY: Record<OtpPurpose, { subject: string; heading: string; body: string }> = {
  VERIFY_EMAIL: { subject: 'Your AfiCre8 verification code', heading: 'Confirm your email', body: 'Enter this code in the app to verify your email address.' },
  RESET_PASSWORD: { subject: 'Reset your AfiCre8 password', heading: 'Reset your password', body: 'Enter this code in the app to choose a new password.' },
};

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async issue(user: { id: string; email: string }, purpose: OtpPurpose) {
    const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
    await this.prisma.$transaction([
      // Only the newest code is valid.
      this.prisma.otpCode.updateMany({ where: { userId: user.id, purpose, consumedAt: null }, data: { consumedAt: new Date() } }),
      this.prisma.otpCode.create({ data: { userId: user.id, purpose, codeHash: await bcrypt.hash(code, 8), expiresAt: new Date(Date.now() + TTL_MS) } }),
    ]);
    await this.mail.send({ to: user.email, ...COPY[purpose], code });
  }

  /** Checks a code; `consume` burns it. Wrong guesses count against a small attempt limit. */
  async check(userId: string, purpose: OtpPurpose, code: string, consume: boolean) {
    const otp = await this.prisma.otpCode.findFirst({ where: { userId, purpose, consumedAt: null }, orderBy: { createdAt: 'desc' } });
    const fail = () => new BadRequestException({ message: 'That code is incorrect or has expired.', code: ErrorCode.InvalidCode });
    if (!otp || otp.expiresAt < new Date() || otp.attempts >= MAX_ATTEMPTS) throw fail();
    if (!(await bcrypt.compare(code, otp.codeHash))) {
      await this.prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw fail();
    }
    if (consume) {
      const claimed = await this.prisma.otpCode.updateMany({ where: { id: otp.id, consumedAt: null }, data: { consumedAt: new Date() } });
      if (claimed.count !== 1) throw fail();
    }
  }
}
