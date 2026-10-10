import { staleTokens } from '../src/notifications/notifications.service.js';

describe('staleTokens', () => {
  it('drops only tokens Expo says are no longer registered, matched by position', () => {
    const tickets = [{ status: 'ok' as const }, { status: 'error' as const, details: { error: 'DeviceNotRegistered' } }, { status: 'error' as const, details: { error: 'MessageRateExceeded' } }];
    expect(staleTokens(['a', 'b', 'c'], tickets)).toEqual(['b']);
  });
});
