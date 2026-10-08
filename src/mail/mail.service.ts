import { Global, Injectable, Logger, Module } from '@nestjs/common';

export type Mail = { to: string; subject: string; heading: string; body: string; code?: string; cta?: { label: string; url: string } };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function render(m: Mail) {
  return `<!doctype html><html><body style="margin:0;background:#f6f1ea;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1b1410">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="100%" style="max-width:480px;background:#ffffff;border-radius:20px;padding:32px" cellpadding="0" cellspacing="0">
<tr><td style="font-weight:800;font-size:20px;letter-spacing:-.02em;color:#ff6a2b">AfiCre8</td></tr>
<tr><td style="padding-top:24px;font-size:22px;font-weight:700">${esc(m.heading)}</td></tr>
<tr><td style="padding-top:12px;font-size:16px;line-height:1.55;color:#4a4038">${esc(m.body)}</td></tr>
${m.code ? `<tr><td style="padding-top:24px"><div style="font-size:36px;font-weight:800;letter-spacing:.35em;background:#f6f1ea;border-radius:14px;padding:18px;text-align:center">${esc(m.code)}</div><div style="padding-top:8px;font-size:13px;color:#8a7f74">Expires in 15 minutes. If you didn't ask for this, ignore this email.</div></td></tr>` : ''}
${m.cta ? `<tr><td style="padding-top:24px"><a href="${esc(m.cta.url)}" style="display:inline-block;background:#ff6a2b;color:#fff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:12px">${esc(m.cta.label)}</a></td></tr>` : ''}
</table><div style="padding-top:16px;font-size:12px;color:#8a7f74">Payment-protected creator collaborations · Payments by Payaza</div>
</td></tr></table></body></html>`;
}

/** Transactional email through Brevo. Without BREVO_API_KEY (tests/local) mail is kept in `outbox` instead. */
@Injectable()
export class MailService {
  private readonly log = new Logger(MailService.name);
  readonly outbox: Mail[] = [];

  async send(m: Mail) {
    const key = process.env.BREVO_API_KEY;
    if (!key) {
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
          htmlContent: render(m),
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

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}
