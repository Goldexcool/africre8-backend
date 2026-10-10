import { z } from 'zod';

export const recommendationInputSchema = z
  .object({
    mode: z
      .enum(['structured', 'tfidf_hybrid', 'semantic_hybrid'])
      .default('structured'),
    limit: z.number().int().min(1).max(100).default(20),
    includeExcluded: z.boolean().default(false),
    includeCredibility: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.includeCredibility && value.limit > 50) {
      ctx.addIssue({
        code: 'custom',
        path: ['limit'],
        message:
          'Credibility-enriched recommendations are limited to 50 creators.',
      });
    }
  });
export type RecommendationInput = z.infer<typeof recommendationInputSchema>;

const signalSchema = z
  .object({ signal: z.string(), value: z.number() })
  .strict();
const explanationSchema = z
  .object({
    summary: z.string(),
    top_signals: z.array(signalSchema),
    components: z.record(z.string(), z.number()),
  })
  .strict();

export const recommendationResponseSchema = z
  .object({
    campaign_id: z.string().nullable(),
    ranker: z.enum(['structured', 'tfidf_hybrid', 'semantic_hybrid']),
    model_version: z.string(),
    candidate_count: z.number().int().nonnegative(),
    eligible_count: z.number().int().nonnegative(),
    excluded_count: z.number().int().nonnegative(),
    recommendations: z.array(
      z
        .object({
          rank: z.number().int().positive(),
          creator_id: z.string(),
          score: z.number(),
          eligible: z.literal(true),
          estimated_fee_usd: z.string().nullable(),
          explanation: explanationSchema,
        })
        .strict(),
    ),
    exclusions: z.array(
      z
        .object({
          creator_id: z.string(),
          eligible: z.boolean(),
          exclusion_reasons: z.array(z.string()),
          estimated_fee_usd: z.string().nullable(),
          campaign_budget_usd: z.string(),
        })
        .strict(),
    ),
    latency_ms: z.number().nonnegative(),
    warnings: z.array(z.string()),
  })
  .strict();
export type RecommendationResponse = z.infer<
  typeof recommendationResponseSchema
>;

export const credibilityResponseSchema = z
  .object({
    creator_id: z.string(),
    status: z.string(),
    credibility_score: z.number().nullable(),
    evidence_tier: z.string(),
    model_version: z.string(),
  })
  .passthrough();
export type CredibilityResponse = z.infer<typeof credibilityResponseSchema>;

export const credibilityBatchResponseSchema = z
  .object({
    results: z.array(credibilityResponseSchema),
  })
  .strict();

export const EVENT_TYPES = [
  'invitation',
  'match',
  'negotiation',
  'withdrawal',
  'contract',
  'submission',
  'cancellation',
  'verification',
  'revision_requested',
  'revision_submitted',
  'dispute',
  'dispute_resolved',
  'completion',
  'rating',
] as const;
export const eventTypeSchema = z.enum(EVENT_TYPES);

export type MlRecommendationRequest = {
  mode: RecommendationInput['mode'];
  campaign: Record<string, unknown>;
  candidates: Record<string, unknown>[];
  limit: number;
  include_excluded: boolean;
};

export type MlCredibilityRequest = {
  creator_id: string;
  events: Record<string, unknown>[];
};
