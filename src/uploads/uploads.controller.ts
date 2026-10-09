import { Body, Controller, ForbiddenException, Get, HttpException, HttpStatus, NotFoundException, Post, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentUser, Public, type AuthUser } from '../common/auth.decorators.js';
import { ErrorCode } from '../common/errors.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { KEY_PREFIX, ObjectStoreService, SIGN_TTL_SECONDS } from './object-store.service.js';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const signSchema = z.object({
  kind: z.enum(['avatar', 'portfolio', 'evidence', 'logo']),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp'], { message: 'Use a JPEG, PNG or WebP image.' }),
  size: z.number().int().min(1).max(MAX_UPLOAD_BYTES, 'That image is larger than 8 MB.'),
});

/** Who may upload what: creators own photos and portfolio, brands own their logo, either side can attach evidence. */
const ROLE_FOR_KIND = { avatar: 'CREATOR', portfolio: 'CREATOR', logo: 'BRAND', evidence: null } as const;

// Light per-user cap on signed URLs (single instance; resets on restart). Each URL can store up to 8 MB.
const SIGN_LIMIT = 40;
const SIGN_WINDOW_MS = 10 * 60_000;
const recent = new Map<string, number[]>();

@Controller()
export class UploadsController {
  constructor(private readonly store: ObjectStoreService) {}

  /** The app uploads straight to storage with the returned URL (PUT, same headers), then saves `publicUrl` on its profile. */
  @Post('uploads/sign')
  async sign(@CurrentUser() u: AuthUser, @Body(new ZodPipe(signSchema)) b: z.infer<typeof signSchema>) {
    if (!this.store.configured) throw new ServiceUnavailableException("Uploads aren't available right now.");
    const need = ROLE_FOR_KIND[b.kind];
    if (need && u.role !== need) throw new ForbiddenException(need === 'BRAND' ? 'Only brands can upload a logo.' : 'Only creators can upload profile photos and portfolio images.');

    const now = Date.now();
    const hits = (recent.get(u.id) ?? []).filter((t) => now - t < SIGN_WINDOW_MS);
    if (hits.length >= SIGN_LIMIT) throw new HttpException({ message: 'Too many uploads. Wait a few minutes and try again.', code: ErrorCode.RateLimited }, HttpStatus.TOO_MANY_REQUESTS);
    recent.set(u.id, [...hits, now]);

    const key = `${KEY_PREFIX}${b.kind}/${u.id}/${randomUUID()}.${EXT[b.contentType]}`;
    const uploadUrl = await this.store.presignPut(key, b.contentType, b.size);
    const base = (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    return {
      method: 'PUT' as const,
      uploadUrl,
      headers: { 'Content-Type': b.contentType },
      key,
      /** Stable URL to store on the profile. Served by this API from storage (no public bucket needed). */
      publicUrl: `${base}/media/${key}`,
      expiresInSeconds: SIGN_TTL_SECONDS,
    };
  }

  /** Public, immutable media: only images under our own prefix, streamed from storage. */
  @Public()
  @Get('media/*path')
  async media(@Req() req: Request, @Res() res: Response) {
    const raw = (req.params as { path?: string | string[] }).path;
    const key = Array.isArray(raw) ? raw.join('/') : (raw ?? '');
    if (!this.store.configured) throw new NotFoundException('Not found');
    if (!key.startsWith(KEY_PREFIX) || key.includes('..') || key.length > 300) throw new NotFoundException('Not found');
    let obj;
    try {
      obj = await this.store.get(key);
    } catch {
      throw new NotFoundException('Not found');
    }
    // never serve anything that is not an image from our domain
    if (!obj.Body || !obj.ContentType?.startsWith('image/')) throw new NotFoundException('Not found');
    res.set({
      'Content-Type': obj.ContentType,
      'Cache-Control': 'public, max-age=31536000, immutable', // keys are random and never overwritten
      'X-Content-Type-Options': 'nosniff',
      ...(obj.ContentLength ? { 'Content-Length': String(obj.ContentLength) } : {}),
    });
    (obj.Body as Readable).on('error', () => res.destroy()).pipe(res);
  }
}

