import { payoutFailure } from '../src/payments/payments.service.js';

describe('payoutFailure', () => {
  it('a provider limit is ours to fix: the creator is told to do nothing', () => {
    const w = payoutFailure('Transfer limit exceeded.');
    expect(w.bank).toBe(false);
    expect(w.creator('₦200,000', 'Launch')).toMatch(/is safe.*transfer limit.*don't need to do anything/);
    expect(w.reason).toMatch(/transfer limit/);
  });
  it('a rejected account sends the creator to their bank details', () => {
    expect(payoutFailure('Invalid beneficiary account number').bank).toBe(true);
  });
  it('anything else is a plain retry', () => {
    expect(payoutFailure('Payaza error 500').reason).toMatch(/didn't go through/);
  });
});
