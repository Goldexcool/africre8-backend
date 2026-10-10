import { ConflictException } from '@nestjs/common';

/** Shown for anything unexpected (5xx, unmapped). Never leaks internals. */
export const UNKNOWN_ERROR = 'An unknown error occurred, try again.';

/** Stable machine-readable codes the mobile app switches on. */
export const ErrorCode = {
  Unauthenticated: 'UNAUTHENTICATED',
  SessionExpired: 'SESSION_EXPIRED',
  InvalidCredentials: 'INVALID_CREDENTIALS',
  AccountSuspended: 'ACCOUNT_SUSPENDED',
  Forbidden: 'FORBIDDEN',
  WrongRole: 'WRONG_ROLE',
  OnboardingRequired: 'ONBOARDING_REQUIRED',
  Validation: 'VALIDATION_ERROR',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  CampaignWrongStage: 'CAMPAIGN_WRONG_STAGE',
  CampaignChanged: 'CAMPAIGN_CHANGED',
  DisputeNotOpen: 'DISPUTE_NOT_OPEN',
  AlreadyResponded: 'ALREADY_RESPONDED',
  PaymentPending: 'PAYMENT_PENDING',
  RateLimited: 'RATE_LIMITED',
  InvalidCode: 'INVALID_CODE',
  TotpRequired: 'TOTP_REQUIRED',
  Internal: 'INTERNAL_ERROR',
} as const;

const STAGE_LABEL: Record<string, string> = {
  pending_agreement: 'waiting for both sides to agree on terms',
  awaiting_funding: 'waiting to be funded',
  funded: 'funded and ready to start',
  in_progress: 'in progress',
  submitted: 'waiting for verification',
  under_review: 'under review',
  revision_required: 'waiting for a revision',
  approved: 'approved and waiting for payout',
  payout_processing: 'being paid out',
  payout_failed: 'waiting for a payout retry',
  completed: 'completed',
  disputed: 'in dispute',
};

/** 409 for "the campaign is in the wrong stage for this action", in plain words. */
export const wrongStage = (status: string, message?: string) =>
  new ConflictException({
    message: message ?? `This campaign is ${STAGE_LABEL[status] ?? status}, so you can't do that right now.`,
    code: ErrorCode.CampaignWrongStage,
  });
