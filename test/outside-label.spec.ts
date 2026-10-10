import { outsideLabel } from '../src/ml/ml.service.js';

describe('outsideLabel', () => {
  it('names the missed brief rule, from the reader’s side, platform before budget', () => {
    expect(outsideLabel(['over_budget', 'missing_required_platform:tiktok'], 'brand')).toBe('No TikTok on their profile');
    expect(outsideLabel(['missing_required_platform:tiktok'], 'creator')).toBe('Needs TikTok on your profile');
    expect(outsideLabel(['over_budget'], 'brand')).toBe('Rate above this brief’s budget');
    expect(outsideLabel(['missing_commercial_rate:instagram:reel'], 'creator')).toBe('Add your Instagram rate to your profile');
    expect(outsideLabel([], 'brand')).toBe('Outside this brief');
  });
});
