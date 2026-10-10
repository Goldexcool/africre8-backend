import { shouldRetryPayout } from '../src/payments/payments.service.js';

const min = 60_000;
const at = (minutesAgo: number, failureReason: string | null = "Payaza's transfer limit was reached; AfiCre8 is raising it and will retry.") => ({ createdAt: new Date(NOW - minutesAgo * min), failureReason });
const NOW = Date.UTC(2026, 9, 10, 12);

describe('shouldRetryPayout', () => {
  it('retries a refused payout 30 minutes after the last attempt', () => {
    expect(shouldRetryPayout([at(31)], NOW)).toBe(true);
    expect(shouldRetryPayout([at(20)], NOW)).toBe(false);
  });
  it('stops 24 hours after the first refusal', () => {
    expect(shouldRetryPayout([at(24 * 60 + 1), at(40)], NOW)).toBe(false);
    expect(shouldRetryPayout([at(23 * 60), at(40)], NOW)).toBe(true);
  });
  it('leaves rejected bank details to the creator', () => {
    expect(shouldRetryPayout([at(60, 'The bank did not accept these account details. Check the account number and bank, then save them to retry.')], NOW)).toBe(false);
  });
  it('retries an older failure with no saved reason', () => {
    expect(shouldRetryPayout([at(45, null)], NOW)).toBe(true);
  });
  it('needs at least one payout', () => {
    expect(shouldRetryPayout([], NOW)).toBe(false);
  });
});
