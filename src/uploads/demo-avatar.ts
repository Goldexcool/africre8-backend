import { createHash } from 'node:crypto';

const PALETTES = [
  ['#132A13', '#90A955'],
  ['#3D405B', '#F2CC8F'],
  ['#5F0F40', '#FB8B24'],
  ['#0B525B', '#97D8C4'],
  ['#4A1942', '#E8C2CA'],
] as const;

export const validSyntheticCreatorId = (value: string) =>
  /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value);

export function syntheticAvatarSvg(sourceCreatorId: string) {
  const digest = createHash('sha256').update(sourceCreatorId).digest();
  const [background, foreground] = PALETTES[digest[0] % PALETTES.length];
  const initials =
    sourceCreatorId
      .replace(/^usr_demo_/, '')
      .split(/[-_]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('') || 'AC';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-labelledby="title description">
  <title id="title">Synthetic AfriCre8 demo creator avatar</title>
  <desc id="description">Generated abstract initials avatar for a fictional demo identity; it is not a photograph of a real person.</desc>
  <rect width="512" height="512" rx="256" fill="${background}"/>
  <circle cx="256" cy="190" r="92" fill="${foreground}" opacity="0.82"/>
  <path d="M96 470c18-116 76-174 160-174s142 58 160 174" fill="${foreground}" opacity="0.82"/>
  <text x="256" y="278" text-anchor="middle" font-family="Arial, sans-serif" font-size="92" font-weight="700" fill="#fff">${initials}</text>
</svg>`;
}
