import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { MlClient } from '../src/ml/ml.client.js';

const config = {
  get: vi.fn(
    (key: string) =>
      ({
        ML_SERVICE_URL: 'http://ml.test',
        ML_REQUEST_TIMEOUT_MS: 2000,
        ML_SEMANTIC_TIMEOUT_MS: 3000,
      })[key],
  ),
} as any;
const valid = {
  campaign_id: 'campaign',
  ranker: 'structured',
  model_version: 'test',
  candidate_count: 0,
  eligible_count: 0,
  excluded_count: 0,
  recommendations: [],
  exclusions: [],
  latency_ms: 1,
  warnings: [],
};

describe('MlClient', () => {
  it('sends the established recommendation contract and validates the response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(valid), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new MlClient(config).recommend(
      {
        mode: 'structured',
        campaign: {},
        candidates: [],
        limit: 10,
        include_excluded: false,
      },
      'request-1',
    );
    expect(result.ranker).toBe('structured');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://ml.test/v1/recommendations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-request-id': 'request-1' }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it('maps an unavailable service to a safe 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('secret network detail')),
    );
    await expect(
      new MlClient(config).recommend({
        mode: 'structured',
        campaign: {},
        candidates: [],
        limit: 10,
        include_excluded: false,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    vi.unstubAllGlobals();
  });

  it('rejects a response that violates the FastAPI contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    );
    await expect(
      new MlClient(config).recommend({
        mode: 'structured',
        campaign: {},
        candidates: [],
        limit: 10,
        include_excluded: false,
      }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    vi.unstubAllGlobals();
  });

  it('maps malformed JSON to a safe gateway error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })),
    );
    await expect(
      new MlClient(config).recommend({
        mode: 'structured',
        campaign: {},
        candidates: [],
        limit: 10,
        include_excluded: false,
      }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    vi.unstubAllGlobals();
  });
});
