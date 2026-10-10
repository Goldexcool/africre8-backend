import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCode } from '../common/errors.js';
import {
  credibilityBatchResponseSchema,
  credibilityResponseSchema,
  recommendationResponseSchema,
  type CredibilityResponse,
  type MlCredibilityRequest,
  type MlRecommendationRequest,
  type RecommendationResponse,
} from './ml.schemas.js';

@Injectable()
export class MlClient {
  private readonly log = new Logger(MlClient.name);
  private readonly baseUrl: string;
  private readonly requestTimeout: number;
  private readonly semanticTimeout: number;

  constructor(config: ConfigService) {
    this.baseUrl = (
      config.get<string>('ML_SERVICE_URL') ?? 'http://127.0.0.1:8001'
    ).replace(/\/$/, '');
    this.requestTimeout = config.get<number>('ML_REQUEST_TIMEOUT_MS') ?? 20_000;
    this.semanticTimeout =
      config.get<number>('ML_SEMANTIC_TIMEOUT_MS') ?? 60_000;
  }

  recommend(
    payload: MlRecommendationRequest,
    requestId?: string,
  ): Promise<RecommendationResponse> {
    const timeout =
      payload.mode === 'semantic_hybrid'
        ? this.semanticTimeout
        : this.requestTimeout;
    return this.post(
      '/v1/recommendations',
      payload,
      recommendationResponseSchema,
      timeout,
      requestId,
    );
  }

  credibility(
    payload: MlCredibilityRequest,
    requestId?: string,
  ): Promise<CredibilityResponse> {
    return this.post(
      '/v1/credibility/score',
      payload,
      credibilityResponseSchema,
      this.requestTimeout,
      requestId,
    );
  }

  async credibilityBatch(
    payload: { creators: MlCredibilityRequest[] },
    requestId?: string,
  ): Promise<CredibilityResponse[]> {
    const response = await this.post(
      '/v1/credibility/batch',
      payload,
      credibilityBatchResponseSchema,
      this.requestTimeout,
      requestId,
    );
    return response.results;
  }

  private async post<T>(
    path: string,
    payload: unknown,
    schema: {
      safeParse(
        value: unknown,
      ): { success: true; data: T } | { success: false };
    },
    timeout: number,
    requestId?: string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(requestId ? { 'x-request-id': requestId } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      this.log.warn(
        `ML request ${path} failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      throw new ServiceUnavailableException({
        message: 'The recommendation service is temporarily unavailable.',
        code: ErrorCode.MlUnavailable,
      });
    }

    if (!response.ok) {
      this.log.warn(`ML request ${path} returned ${response.status}`);
      if (response.status === 503 || response.status === 504) {
        throw new ServiceUnavailableException({
          message: 'The recommendation service is temporarily unavailable.',
          code: ErrorCode.MlUnavailable,
        });
      }
      throw new BadGatewayException({
        message: 'The recommendation service returned an invalid response.',
        code: ErrorCode.MlUnavailable,
      });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      this.log.error(`ML response was not JSON for ${path}`);
      throw new BadGatewayException({
        message: 'The recommendation service returned an invalid response.',
        code: ErrorCode.MlUnavailable,
      });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      this.log.error(`ML response contract mismatch for ${path}`);
      throw new BadGatewayException({
        message: 'The recommendation service returned an invalid response.',
        code: ErrorCode.MlUnavailable,
      });
    }
    return parsed.data;
  }
}
