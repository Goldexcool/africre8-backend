import { describe, expect, it } from 'vitest';
import { kycProvider } from '../src/kyc/kyc.module.js';

describe('kycProvider', () => {
  it('uses Dojah when asked, the mock only outside production, and nothing in production otherwise', async () => {
    expect(kycProvider({ KYC_PROVIDER: 'dojah', NODE_ENV: 'production' }).name).toBe('dojah');
    expect(kycProvider({ KYC_PROVIDER: 'mock', NODE_ENV: 'development' }).name).toBe('mock');
    const prod = kycProvider({ KYC_PROVIDER: 'mock', NODE_ENV: 'production' });
    expect(prod.name).toBe('unavailable');
    expect(await prod.verifyNin({ nin: '70123456789', selfieBase64: '' })).toEqual({ outcome: 'unavailable' }); // the test NIN does not pass in production
  });
});
