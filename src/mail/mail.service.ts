import { Controller, Get, Global, Injectable, Logger, Module, Res } from '@nestjs/common';
import type { Response } from 'express';
import sharp from 'sharp';
import { Public } from '../common/auth.decorators.js';
import { LOGO_SVG, renderHtml, renderText, type Mail } from './mail.template.js';

export type { Mail };

const TEST_DOMAIN = /@(?:[a-z0-9-]+\.)*africre8\.dev$/i;

/** Transactional email through Brevo. Without BREVO_API_KEY (tests/local) mail is kept in `outbox` instead. */
@Injectable()
export class MailService {
  private readonly log = new Logger(MailService.name);
  readonly outbox: Mail[] = [];

  async send(m: Mail) {
    const key = process.env.BREVO_API_KEY;
    // Test accounts (e2e/probe @*.africre8.dev) have no inbox; sending them burned the daily Brevo quota.
    if (!key || TEST_DOMAIN.test(m.to)) {
      this.outbox.push(m);
      if (this.outbox.length > 100) this.outbox.shift();
      return;
    }
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: process.env.MAIL_FROM_NAME ?? 'AfiCre8', email: process.env.MAIL_FROM_EMAIL },
          to: [{ email: m.to }],
          subject: m.subject,
          htmlContent: renderHtml(m),
          textContent: renderText(m),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) this.log.warn(`Brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      // Email is best-effort; in-app notifications remain the source of truth.
      this.log.warn(`Brevo send failed: ${(e as Error).message}`);
    }
  }
}

/** The logo emails show (mail clients don't render SVG), rendered once from the app's mark at 3x. */
let logoPng: Promise<Buffer> | null = null;

@Controller('email')
class MailAssetsController {
  @Public()
  @Get('logo.png')
  async logo(@Res() res: Response) {
    logoPng ??= sharp(Buffer.from(LOGO_SVG)).resize(123, 60).png().toBuffer();
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }).send(await logoPng);
  }
}

@Global()
@Module({ controllers: [MailAssetsController], providers: [MailService], exports: [MailService] })
export class MailModule {}
