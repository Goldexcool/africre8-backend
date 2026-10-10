import { createHmac, randomBytes } from 'node:crypto';

/** RFC 6238 time-based one-time passwords (what Google Authenticator, 1Password and Authy produce). No dependency needed. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newSecret(): string {
  const bytes = randomBytes(20);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  return (bits.match(/.{1,5}/g) ?? []).map((c) => ALPHABET[parseInt(c.padEnd(5, '0'), 2)]).join('');
}

function decode(secret: string): Buffer {
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) {
    const i = ALPHABET.indexOf(ch);
    if (i >= 0) bits += i.toString(2).padStart(5, '0');
  }
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
}

export function codeAt(secret: string, timeMs: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30_000)));
  const h = createHmac('sha1', decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** Accepts the current code and the one before and after (clock drift of up to 30 seconds). */
export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((step) => codeAt(secret, now + step * 30_000) === code);
}

export const otpauthUri = (secret: string, email: string) => `otpauth://totp/AfiCre8%20Admin:${encodeURIComponent(email)}?secret=${secret}&issuer=AfiCre8%20Admin`;
