export type ProviderStatus = 'pending' | 'successful' | 'failed';

export type BankTransferInstructions = {
  method: 'bank_transfer';
  accountNumber: string;
  accountName: string;
  bankName: string;
  amountNgn: number;
  expiresAt: string;
};
export type CardInstructions = { method: 'card'; checkoutUrl: string; amountNgn: number };
export type FundingInstructions = BankTransferInstructions | CardInstructions;

export type Customer = { email: string; firstName: string; lastName: string; phone?: string };

export interface PaymentProvider {
  readonly name: string;
  createFunding(input: { reference: string; amountNgn: number; method: 'bank_transfer' | 'card'; customer: Customer; description: string }): Promise<FundingInstructions>;
  queryFunding(reference: string, method: string): Promise<{ status: ProviderStatus; raw: unknown; providerStatus?: string }>;
  simulateBankTransfer?(reference: string, instructions: BankTransferInstructions): Promise<{ ok: boolean; message: string }>;
  payout(input: { reference: string; amountNgn: number; bankCode: string; accountNumber: string; accountName: string; narration: string }): Promise<{ status: ProviderStatus | 'processing'; raw: unknown; providerStatus?: string }>;
  queryPayout(reference: string): Promise<{ status: ProviderStatus; raw: unknown; providerStatus?: string }>;
  resolveAccount(bankCode: string, accountNumber: string): Promise<{ accountName: string }>;
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
