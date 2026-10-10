const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Test mode only: Payaza's sandbox checkout fails on its own "Transfer" option ("Kindly check the provided
 * Authorization"), and its SDK cannot hide it. Point testers at Card, or at the app's own bank transfer.
 */
const TEST_HINT = `<div class="test" role="note"><b>Test mode.</b> In the Payaza window choose <b>Card</b>, not Transfer (Payaza's sandbox transfer option is broken).<br>
Test card <code>5111 1111 1111 1118</code> · exp <code>01/39</code> · CVV <code>100</code><br>
To pay by bank transfer, close this page and tap <b>Pay by bank transfer</b> in the app.</div>`;

/** Minimal hosted page that opens the Payaza Checkout SDK, then asks our API to verify with Payaza. */
export function checkoutPage(o: {
  publicKey: string;
  mode: 'Test' | 'Live';
  reference: string;
  amountNgn: number;
  title: string;
  email: string;
  firstName: string;
  lastName: string;
  returnUrl: string;
}) {
  const cfg = JSON.stringify({
    merchant_key: o.publicKey,
    connection_mode: o.mode,
    checkout_amount: o.amountNgn,
    currency_code: 'NGN',
    email_address: o.email,
    first_name: o.firstName,
    last_name: o.lastName,
    phone_number: '+2348000000000',
    transaction_reference: o.reference,
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fund campaign · AfiCre8</title>
<script defer src="https://checkout-v2.payaza.africa/js/v1/bundle.js"></script>
<style>
  :root{color-scheme:light dark;--bg:#0f0d0b;--fg:#f6efe6;--muted:#a89f93;--accent:#ff7a3d}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}
  main{width:min(420px,100% - 32px);text-align:center}
  h1{font-size:22px;margin:0 0 4px} p{color:var(--muted);margin:0 0 24px}
  .amt{font-size:40px;font-weight:700;letter-spacing:-.02em;margin:8px 0 24px}
  button{width:100%;padding:16px;border:0;border-radius:14px;background:var(--accent);color:#1a0f08;font-weight:700;font-size:17px}
  #status{margin-top:16px;min-height:24px}
  .test{margin-top:20px;padding:14px 16px;border:1px dashed #5a5047;border-radius:14px;text-align:left;font-size:14px;color:var(--muted)}
  .test b{color:var(--fg)} .test code{font:600 14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg)}
</style></head>
<body><main>
  <p>Fund campaign</p><h1>${esc(o.title)}</h1>
  <div class="amt">₦${o.amountNgn.toLocaleString('en-NG')}</div>
  <button id="pay">Pay with Payaza</button>
  <div id="status" role="status"></div>
  ${o.mode === 'Test' ? TEST_HINT : ''}
</main>
<script>
  const cfg = ${cfg};
  const status = document.getElementById('status');
  async function verify() {
    status.textContent = 'Confirming with Payaza…';
    for (let i = 0; i < 10; i++) {
      const r = await fetch('/pay/' + cfg.transaction_reference + '/check', { method: 'POST' }).then(r => r.json()).catch(() => ({}));
      if (r.status === 'successful') { status.textContent = 'Payment confirmed. Returning to AfiCre8…'; location.href = ${JSON.stringify(o.returnUrl)}; return; }
      if (r.status === 'failed') { status.textContent = 'Payment failed. You can try again.'; return; }
      await new Promise(r => setTimeout(r, 3000));
    }
    status.textContent = 'Still processing. You can return to the app; we will update it automatically.';
  }
  document.getElementById('pay').onclick = () => {
    const c = PayazaCheckout.setup(cfg);
    c.setCallback(() => verify());
    c.setOnClose(() => verify());
    c.showPopup();
  };
</script></body></html>`;
}
