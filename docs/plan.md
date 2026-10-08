# AfiCre8 backend — build plan

Hackathon: The Fusion Hack · Track: Payments & Monetization · 3 days.
Golden path: brand swipes → creator accepts → chat → agreement → Payaza funds → creator posts → Claude verifies → brand approves → Payaza pays out.

**Workflow:** take the next unchecked task → build it → run its check → tick it → update *Last completed* → commit.

## Last completed
**Tasks 9, 10, 12: Verification, review/admin, golden path** (2026-10-08)
- **Submissions**: `POST /campaigns/:id/submissions` (creator).
  - The link's platform must match the deliverable; a wrong platform gets 400. Late submissions are flagged.
  - Earlier submissions are kept as `superseded` history.
  - Once every deliverable is covered, the campaign moves to `submitted` and the brand is notified. One BullMQ `verify` job is queued per submission. `POST .../submissions/:sid/reverify`.
- **Verification worker** (`src/verification`, no Claude):
  1. metadata via yt-dlp, falling back to YouTube Data API or oEmbed
  2. objective checks: post is public, posted from the creator's handle, published after the agreement, hashtags, mentions
  3. **ffmpeg splits the video into 6 frames and extracts the audio**
  4. **Groq Whisper (`whisper-large-v3-turbo`) transcribes the audio** to catch spoken mentions and talking points
  5. **Azure OpenAI `gpt-5.3-chat`** checks the frames, transcript and caption against the agreement (strict JSON schema)
  6. if there are no frames or Azure fails, Groq `gpt-oss-120b` checks text only, capped at 0.5 confidence, which means NEEDS_REVIEW
  - `verdictFor()`: account/publish failure is FAIL; anything uncertain is NEEDS_REVIEW; all passing is PASS; otherwise PARTIAL.
  - Evidence (metadata, stats, transcript, frames) is stored on `VerificationRun`, so it survives the post being deleted. Once every live submission is verified, the campaign moves to `under_review` and the brand is notified.
- **Review** (`src/review`): `POST /campaigns/:id/approve` (brand, only from `under_review`) releases the payout, or asks the creator for bank details first. `POST .../revision {note}` is limited by `revisionLimit`. `POST .../dispute` (either party) pauses payout and notifies the other party and admins.
- Payout account names now come from Payaza name enquiry, not the client. Saving bank details auto-releases approved or `payout_failed` campaigns.
- **Admin API** (`/admin/*`, ADMIN role): overview, users (suspend/unsuspend/verify; suspending revokes sessions), campaigns, transactions, webhooks + **replay**, verifications, disputes + resolve (`release|revision|resume`), audit.
- Verified: `test/golden-path.e2e-spec.ts` covers the PRD end-to-end flow up to completed, the revision limit, kept history, dispute pausing approval, admin release then completion, and webhook replay leaving exactly one payout. 14/14 e2e tests pass.

## Stack
NestJS · Prisma/Postgres (Neon) · Redis + BullMQ (separate worker process) · Socket.IO · Cloudinary · Payaza · Azure OpenAI (vision) + Groq (Whisper) · Docker + nginx · Railway.

## Tasks
- [x] 1. Scaffold Nest + Prisma (Neon) + env validation + `/health`. Push to GitHub.
- [x] 2. Dockerfile (api + worker from one image) + docker-compose (nginx → api, worker, redis). Check: `docker compose up`, `curl localhost/health` via nginx.
- [x] 3. Auth: register/login, access JWT (15m) + rotating refresh tokens (hashed, family reuse detection), logout, RolesGuard, onboarding guard. Check: e2e covers rotation + reuse revoking the family.
- [x] 4. Profiles (creator/brand/socials/payout destination), Cloudinary signed upload, seed (30 creators, 3 brands, 1 admin).
- [x] 5. Discovery (filters, excludes swiped/unavailable) + swipe + interest (expiry) + accept/decline → match + conversation.
- [x] 6. Socket.IO gateway (JWT auth, match-member rooms, chat) + notifications (DB + socket).
- [x] 7. Campaigns: create/edit terms (version bump resets acceptance), bilateral accept, state machine + AuditLog.
- [x] 8. Payments: PaymentProvider (Mock + Payaza TEST), fund, webhook (signature, dedupe, re-query), reconcile job, payout, banks + name enquiry.
- [x] 9. Verification worker: YouTube Data API + TikTok oEmbed + yt-dlp/ffmpeg frames → Claude → PASS/PARTIAL/FAIL/NEEDS_REVIEW.
- [x] 10. Review (approve → payout, revision, dispute) + admin API (users, campaigns, transactions, webhook replay, verifications, disputes).
- [ ] 10b. Email via Brevo: signup verification code, forgot/reset password (6-digit codes, hashed, 15-min expiry), money emails (funded, payout sent/failed).
- [ ] 11. Railway deploy (api + worker + redis), migrate, seed; set Payaza webhook URL.
- [x] 12. Golden-path e2e (`test/golden-path.e2e-spec.ts`, MockProvider): duplicate webhook ⇒ one payout; failed payout stays `payout_failed`.

Mobile tasks (wire to API, full-screen swipe, UI/animation overhaul, admin web) are tracked in the mobile repo.

## Rules that must hold
- A campaign is `funded` only after Payaza confirms (webhook or status re-query), never from the client.
- `completed` only after a successful payout. Failed payouts stay `payout_failed`.
- One campaign → at most one live payout (DB partial unique index) and idempotency keys on every money call.
- Duplicate webhooks are no-ops (`WebhookEvent.eventId` unique).
- Every status/money transition writes an `AuditLog` row.
- Secrets live only in `.env` / Railway variables.

## Running
```sh
cp .env.example .env   # fill values
npm i
npx prisma migrate deploy
npm run start:dev
```
