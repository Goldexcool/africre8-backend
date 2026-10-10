/**
 * The AfiCre8 email, in the app's design language: black and white, Plus Jakarta Sans for headings over the system
 * face, 12/22px radii, hairline borders, one black action. Table layout and inline styles so Gmail, Outlook and Apple
 * Mail all render it; Apple Mail and iOS also get the app's dark palette.
 */
export type Mail = {
  to: string;
  subject: string;
  heading: string;
  body: string;
  /** A one-time code, shown digit by digit like the app's code input. */
  code?: string;
  cta?: { label: string; url: string };
};

/** The infinity mark from the app (assets/images/infinity-logo.svg), served as a PNG at /email/logo.png. */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="246" height="120" viewBox="0 0 82 40"><path d="M61.8144 0C57.268 0 52.3045 2.41919 47.049 7.21585C44.5464 9.4682 42.3775 11.8874 40.7925 13.8478C40.7925 13.8478 43.3368 16.7258 46.1314 19.8123C47.6329 17.9353 49.8436 15.391 52.3462 13.097C57.0177 8.84254 60.0626 7.96663 61.8144 7.96663C68.3629 7.96663 73.7018 13.3472 73.7018 20.0209C73.7018 26.6111 68.4046 31.9917 61.8144 32.0751C61.5224 32.0751 61.1053 32.0334 60.6882 31.9499C62.6069 32.8259 64.6507 33.4515 66.611 33.4515C78.6236 33.4515 80.9593 25.318 81.1262 24.7341C81.4598 23.2325 81.6684 21.6893 81.6684 20.0626C81.585 8.96767 72.7424 0 61.8144 0Z" fill="#0A0A0A"/><path d="M19.854 40.0001C24.4004 40.0001 29.3639 37.5809 34.6194 32.7842C37.122 30.5319 39.2909 28.1127 40.8759 26.1523C40.8759 26.1523 38.3316 23.2743 35.537 20.1878C34.0355 22.0647 31.8248 24.6091 29.3222 26.9031C24.6507 31.1576 21.6058 32.0335 19.854 32.0335C13.3055 32.0335 7.96663 26.6529 7.96663 19.9792C7.96663 13.389 13.2638 8.00844 19.854 7.92502C20.146 7.92502 20.5631 7.96673 20.9802 8.05015C19.0615 7.17424 17.0177 6.54858 15.0574 6.54858C3.04484 6.54858 0.709072 14.6821 0.542232 15.266C0.208551 16.7676 0 18.3108 0 19.9375C0.0417101 30.9907 8.92597 40.0001 19.854 40.0001Z" fill="#0A0A0A"/><path fill-rule="evenodd" d="M15.099 6.75704C21.2721 6.92388 27.6955 12.0125 28.9885 13.2638C32.0633 16.2248 34.9655 19.5312 35.4937 20.1332C35.5459 20.1926 35.5749 20.2257 35.5787 20.2294C38.3733 23.316 40.9176 26.194 40.9176 26.194L40.9593 26.1522C46.6736 32.7007 54.3065 40 61.8978 40C71.1991 39.9583 79.0406 33.4098 81.1261 24.609C80.9176 25.2346 77.831 33.4515 66.5693 33.1595C60.4379 32.9927 54.0146 27.9458 52.7215 26.6945C49.343 23.4411 46.1731 19.7706 46.1731 19.7706C43.3785 16.684 40.8342 13.806 40.8342 13.806C40.7924 13.806 40.7924 13.8478 40.7924 13.8478C35.1199 7.25756 27.4869 0 19.8957 0C10.5943 0.0417101 2.75283 6.54849 0.66732 15.3076C0.917581 14.2649 4.12926 6.50678 15.099 6.75704Z" fill="#0A0A0A"/></svg>`;

// App tokens (src/constants/theme.ts, light): text, textSecondary, textFaint, border, backgroundSubtle.
const C = { ink: '#0A0A0A', soft: '#5C5C5C', faint: '#6B6B6B', line: '#E5E5E5', canvas: '#F5F5F5', card: '#FFFFFF' };
const DISPLAY = "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const TEXT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const publicBase = () => (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '');

/** The code as separate cells, the way the app's code input shows it; the full code is also in the subject and preheader. */
function codeCells(code: string) {
  const cells = [...code]
    .map(
      (d) =>
        `<td class="cell" width="56" height="68" align="center" valign="middle" style="width:56px;height:68px;background:${C.canvas};border:1px solid ${C.line};border-radius:12px;font-family:${DISPLAY};font-size:30px;line-height:68px;font-weight:700;color:${C.ink};font-variant-numeric:tabular-nums;mso-line-height-rule:exactly">${esc(d)}</td>`,
    )
    .join('<td width="10" style="width:10px;font-size:0;line-height:0">&nbsp;</td>');
  return `<tr><td style="padding:28px 0 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0" aria-label="Your code is ${esc([...code].join(' '))}"><tr>${cells}</tr></table></td></tr>
<tr><td class="faint" style="padding:14px 0 0;font-family:${TEXT};font-size:13px;line-height:19px;color:${C.faint}">Expires in 15 minutes. If you didn&#39;t ask for this, you can ignore this email; nothing changes on your account.</td></tr>`;
}

function button(cta: NonNullable<Mail['cta']>) {
  const url = esc(cta.url);
  return `<tr><td style="padding:28px 0 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="btn" bgcolor="${C.ink}" style="border-radius:12px;background:${C.ink}">
<a class="btn-a" href="${url}" style="display:inline-block;padding:16px 26px;font-family:${TEXT};font-size:16px;line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:12px">${esc(cta.label)}</a>
</td></tr></table></td></tr>
<tr><td class="faint" style="padding:12px 0 0;font-family:${TEXT};font-size:12px;line-height:17px;color:${C.faint};word-break:break-all">Or open this link: <a href="${url}" style="color:${C.soft}">${url}</a></td></tr>`;
}

export function renderHtml(m: Mail) {
  const preheader = m.code ? `${m.code} is your code. It expires in 15 minutes.` : m.body;
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(m.subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@700;800&display=swap" rel="stylesheet">
<style>
  body{margin:0;padding:0;-webkit-text-size-adjust:100%}
  a{color:${C.ink}}
  @media (max-width:520px){ .pad{padding:28px 22px !important} .h1{font-size:24px !important;line-height:30px !important} .cell{width:48px !important;height:60px !important;line-height:60px !important;font-size:26px !important} }
  @media (prefers-color-scheme:dark){
    body,.canvas{background:#000000 !important}
    .card{background:#111111 !important;border-color:#262626 !important}
    .ink,.h1,.cell{color:#FAFAFA !important}
    .soft{color:#A3A3A3 !important}
    .faint{color:#8C8C8C !important}
    .cell{background:#1C1C1C !important;border-color:#262626 !important}
    .btn{background:#FFFFFF !important}
    .btn-a{color:#000000 !important}
    .logo{filter:invert(1)}
  }
</style>
</head>
<body class="canvas" style="margin:0;padding:0;background:${C.canvas}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.canvas}">${esc(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" class="canvas" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.canvas}">
<tr><td align="center" style="padding:40px 16px 48px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px">

<tr><td style="padding:0 4px 22px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td valign="middle" style="padding-right:10px"><img class="logo" src="${publicBase()}/email/logo.png" width="41" height="20" alt="" style="display:block;border:0;width:41px;height:20px"></td>
    <td valign="middle" class="ink" style="font-family:${DISPLAY};font-size:18px;line-height:20px;font-weight:800;letter-spacing:-0.3px;color:${C.ink}">AfiCre8</td>
  </tr></table>
</td></tr>

<tr><td class="card pad" style="background:${C.card};border:1px solid ${C.line};border-radius:22px;padding:36px 32px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td class="h1" style="font-family:${DISPLAY};font-size:26px;line-height:32px;font-weight:700;letter-spacing:-0.5px;color:${C.ink}">${esc(m.heading)}</td></tr>
    <tr><td class="soft" style="padding:12px 0 0;font-family:${TEXT};font-size:16px;line-height:25px;color:${C.soft}">${esc(m.body)}</td></tr>
    ${m.code ? codeCells(m.code) : ''}
    ${m.cta ? button(m.cta) : ''}
  </table>
</td></tr>

<tr><td class="faint" style="padding:22px 4px 0;font-family:${TEXT};font-size:12px;line-height:18px;color:${C.faint}">
  Payment-protected creator collaborations. Money is held before work starts and released when it&#39;s done. Payments by Payaza.<br>
  You&#39;re getting this because you have an AfiCre8 account.
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

/** The plain-text part: same words, no layout. */
export function renderText(m: Mail) {
  return [
    m.heading,
    '',
    m.body,
    ...(m.code ? ['', `Your code: ${m.code}`, 'It expires in 15 minutes. If you didn’t ask for this, you can ignore this email.'] : []),
    ...(m.cta ? ['', `${m.cta.label}: ${m.cta.url}`] : []),
    '',
    '—',
    'AfiCre8 · Payment-protected creator collaborations. Payments by Payaza.',
  ].join('\n');
}
