import type { BankTransferInstructions, PaymentProvider, ProviderStatus } from './provider.js';

/**
 * In-memory stand-in used by tests and offline demos. Funding stays pending until simulated;
 * payouts to account 0000000000 fail, everything else succeeds on the first status query.
 */
export class MockProvider implements PaymentProvider {
  readonly name = 'mock';
  private readonly state = new Map<string, ProviderStatus>();

  constructor(private readonly publicUrl: string) {}

  async createFunding({ reference, amountNgn, method }: { reference: string; amountNgn: number; method: 'bank_transfer' | 'card' }) {
    this.state.set(reference, 'pending');
    if (method === 'card') return { method: 'card' as const, checkoutUrl: `${this.publicUrl}/pay/${reference}`, amountNgn };
    return {
      method: 'bank_transfer' as const,
      accountNumber: '9' + reference.replace(/\D/g, '').padEnd(9, '0').slice(0, 9),
      accountName: 'Mock(AfiCre8 Campaign)',
      bankName: 'MOCK BANK',
      amountNgn,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
  }

  async queryFunding(reference: string) {
    const status = this.state.get(reference) ?? 'pending';
    return { status, raw: { mock: true, status }, providerStatus: status };
  }

  async simulateBankTransfer(reference: string, _i: BankTransferInstructions) {
    this.state.set(reference, 'successful');
    return { ok: true, message: 'Mock transfer received' };
  }

  /** Test hook: force a funding outcome. */
  setStatus(reference: string, status: ProviderStatus) {
    this.state.set(reference, status);
  }

  async payout({ reference, accountNumber }: { reference: string; accountNumber: string }) {
    this.state.set(reference, accountNumber === '0000000000' ? 'failed' : 'successful');
    return { status: 'processing' as const, raw: { mock: true }, providerStatus: 'TRANSACTION_INITIATED' };
  }

  async queryPayout(reference: string) {
    const status = this.state.get(reference) ?? 'pending';
    return { status, raw: { mock: true, status }, providerStatus: status };
  }

  async resolveAccount(_bankCode: string, accountNumber: string) {
    return { accountName: `MOCK ACCOUNT ${accountNumber.slice(-4)}` };
  }

  verifyWebhook() {
    return true;
  }
}
