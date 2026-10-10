import { BadGatewayException, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BankTransferInstructions, Customer, FundingInstructions, PaymentProvider, ProviderStatus } from './provider.js';

const BASE = 'https://api.payaza.africa/live';
const DVA_BANK_CODE = '140'; // Globus; Payaza also offers 1067 (78 Finance) and 117 (Fidelity)

// Docs: https://docs.payaza.africa (virtual accounts, card status, transfers, webhooks)
export class PayazaProvider implements PaymentProvider {
  readonly name = 'payaza';
  private readonly log = new Logger('Payaza');
  private accountRef?: string;

  constructor(
    private readonly cfg: { publicKey: string; secretKey: string; tenant: 'test' | 'live'; publicUrl: string; transactionPin?: string },
  ) {}

  private async call<T = any>(method: 'GET' | 'POST', path: string, body?: unknown, accept400 = false): Promise<T> {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: `Payaza ${Buffer.from(this.cfg.publicKey).toString('base64')}`,
        'X-TenantID': this.cfg.tenant,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new BadGatewayException(`Payaza ${path} returned non-JSON (${res.status})`);
    }
    if (!res.ok && !(accept400 && res.status === 400)) {
      this.log.warn(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
      throw new BadGatewayException(json?.message ?? `Payaza error ${res.status}`);
    }
    return json as T;
  }

  async createFunding({ reference, amountNgn, method, customer, description }: { reference: string; amountNgn: number; method: 'bank_transfer' | 'card'; customer: Customer; description: string }): Promise<FundingInstructions> {
    if (method === 'card') {
      // Hosted page (served by us) that opens the Payaza Checkout SDK; confirmation still comes from status re-query.
      return { method: 'card', checkoutUrl: `${this.cfg.publicUrl}/pay/${reference}`, amountNgn };
    }
    const r = await this.call('POST', '/merchant-collection/merchant/virtual_account/generate_virtual_account', {
      account_name: 'AfiCre8 Campaign',
      account_type: 'Dynamic',
      bank_code: DVA_BANK_CODE,
      bvn: '',
      has_amount_validation: 'true',
      account_reference: reference,
      customer_first_name: customer.firstName,
      customer_last_name: customer.lastName,
      customer_email: customer.email,
      customer_phone_number: customer.phone ?? '08000000000',
      transaction_description: description.slice(0, 100),
      transaction_amount: String(amountNgn),
      expires_in_minutes: '60',
    });
    if (!r.success) throw new BadGatewayException(r.message ?? 'Could not create virtual account');
    return {
      method: 'bank_transfer',
      accountNumber: r.data.account_number,
      accountName: r.data.account_name,
      bankName: r.data.bank_name,
      amountNgn: Number(r.data.transaction_amount_payable ?? amountNgn),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
  }

  async queryFunding(reference: string, method: string) {
    if (method === 'card') {
      // An unpaid checkout comes back as 400 "Transaction not processed" with response_content.transaction_status "Pending".
      const r = await this.call('POST', '/card/card_charge/transaction_status', { service_payload: { transaction_reference: reference } }, true);
      const s = String(r?.data?.transaction_status ?? r?.response_content?.transaction_status ?? '');
      if (!s && r?.response_code === 400) throw new BadGatewayException(r.response_message ?? 'Payaza error 400');
      const paid = Number(r?.response_content?.transaction_amount ?? r?.data?.transaction_amount);
      return { status: mapCollection(s), raw: r, providerStatus: s, ...(Number.isFinite(paid) && { amountNgn: paid }) };
    }
    const r = await this.call('GET', `/merchant-collection/transfer_notification_controller/transaction-query?transaction_reference=${encodeURIComponent(reference)}`);
    const s = String(r?.data?.transaction_status ?? '');
    return { status: mapCollection(s), raw: r, providerStatus: s };
  }

  async simulateBankTransfer(reference: string, i: BankTransferInstructions) {
    if (this.cfg.tenant !== 'test') return { ok: false, message: 'Simulation is sandbox-only' };
    const r = await this.call('POST', '/merchant-collection/payaza/virtual_account/fund_test_virtual_account', {
      account_name: i.accountName,
      account_number: i.accountNumber,
      initiation_transaction_reference: reference,
      transaction_amount: String(i.amountNgn),
      currency: 'NGN',
      source_account_number: '0123456789',
      source_account_name: 'AfiCre8 Demo Brand',
      source_bank_name: 'Test Bank',
    }).catch((e: Error) => ({ success: false, message: e.message }));
    return { ok: Boolean(r.success), message: r.message ?? '' };
  }

  private async accountReference() {
    if (this.accountRef) return this.accountRef;
    const r = await this.call('GET', '/payaza-account/api/v1/mainaccounts/merchant/enquiry/main');
    const main = (r.data ?? []).find((a: any) => a.currency === 'NGN') ?? r.data?.[0];
    if (!main?.payazaAccountReference) throw new BadGatewayException('No Payaza NGN payout account');
    return (this.accountRef = main.payazaAccountReference as string);
  }

  async payout({ reference, amountNgn, bankCode, accountNumber, accountName, narration }: { reference: string; amountNgn: number; bankCode: string; accountNumber: string; accountName: string; narration: string }) {
    if (!this.cfg.transactionPin) throw new BadGatewayException('PAYAZA_TRANSACTION_PIN not configured');
    const r = await this.call('POST', '/payout-receptor/payout', {
      transaction_type: 'nuban',
      service_payload: {
        payout_amount: amountNgn,
        transaction_pin: Number(this.cfg.transactionPin),
        account_reference: await this.accountReference(),
        currency: 'NGN',
        country: 'NGA',
        payout_beneficiaries: [
          {
            credit_amount: amountNgn,
            account_number: accountNumber,
            account_name: accountName,
            bank_code: bankCode,
            narration: narration.slice(0, 50),
            transaction_reference: reference,
            sender: { sender_name: 'AfiCre8', sender_id: '', sender_phone_number: '08000000000', sender_address: 'Lagos, Nigeria' },
          },
        ],
      },
    });
    const s = String(r?.response_status ?? r?.transaction_status ?? r?.data?.response_status ?? '');
    const mapped = mapPayout(s);
    return { status: mapped === 'pending' ? ('processing' as const) : mapped, raw: r, providerStatus: s };
  }

  async queryPayout(reference: string) {
    const r = await this.call('GET', `/payaza-account/api/v1/mainaccounts/transaction/status?transaction_reference=${encodeURIComponent(reference)}`);
    const s = String(r?.data?.transactionStatus ?? r?.transactionStatus ?? '');
    return { status: mapPayout(s), raw: r, providerStatus: s };
  }

  async resolveAccount(bankCode: string, accountNumber: string) {
    const r = await this.call('POST', '/payaza-account/api/v1/mainaccounts/merchant/provider/enquiry', {
      service_payload: { currency: 'NGN', bank_code: bankCode, account_number: accountNumber },
    });
    const name = r?.response_content?.account_name ?? r?.data?.account_name;
    if (!name) throw new BadGatewayException('Account could not be resolved');
    return { accountName: String(name) };
  }

  /** HMAC-SHA512 of the raw body with the secret key, base64 (docs: Webhooks). */
  verifyWebhook(rawBody: Buffer, signature: string | undefined) {
    if (!signature) return false;
    const expected = Buffer.from(createHmac('sha512', this.cfg.secretKey).update(rawBody).digest('base64'));
    const got = Buffer.from(signature);
    return expected.length === got.length && timingSafeEqual(expected, got);
  }
}

function mapCollection(s: string): ProviderStatus {
  const v = s.toLowerCase();
  if (['completed', 'funds received', 'successful', 'success', 'approved'].includes(v)) return 'successful';
  if (['failed', 'declined', 'expired', 'reversed', 'cancelled'].some((x) => v.includes(x))) return 'failed';
  return 'pending';
}

function mapPayout(s: string): ProviderStatus {
  const v = s.toUpperCase();
  if (v === 'NIP_SUCCESS' || v === 'SUCCESSFUL' || v === 'SUCCESS') return 'successful';
  if (v.includes('FAIL') || v.includes('REVERS')) return 'failed';
  return 'pending'; // TRANSACTION_INITIATED, NIP_PENDING, ESCROW_SUCCESS
}
