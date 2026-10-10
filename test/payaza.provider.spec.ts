import { BadGatewayException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayazaProvider } from '../src/payments/payaza.provider.js';

const provider = new PayazaProvider({ publicKey: 'pk', secretKey: 'sk', tenant: 'test', publicUrl: 'http://x' });
const reply = (status: number, body: unknown) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe('PayazaProvider.queryFunding (card)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('treats an unpaid checkout (400 "Transaction not processed") as pending', async () => {
    reply(400, { response_code: 400, response_message: 'Transaction not processed.', response_content: { transaction_reference: 'R', transaction_status: 'Pending' } });
    await expect(provider.queryFunding('R', 'card')).resolves.toMatchObject({ status: 'pending', providerStatus: 'Pending' });
  });

  it('still throws on a 400 without a status', async () => {
    reply(400, { response_code: 400, response_message: 'Invalid reference' });
    await expect(provider.queryFunding('R', 'card')).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a successful charge', async () => {
    reply(200, { data: { transaction_status: 'Completed' } });
    await expect(provider.queryFunding('R', 'card')).resolves.toMatchObject({ status: 'successful' });
  });

  it('reports what was paid, as Payaza returns it for a checkout looked up by its own id', async () => {
    reply(200, { response_code: 200, response_message: 'Transaction data found', response_content: { transaction_reference: 'P-C-1', transaction_amount: 210000.0, transaction_status: 'Completed' } });
    await expect(provider.queryFunding('P-C-1', 'card')).resolves.toMatchObject({ status: 'successful', amountNgn: 210000 });
  });
});
