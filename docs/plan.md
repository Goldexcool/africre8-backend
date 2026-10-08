# AfiCre8 backend — build plan

Hackathon: The Fusion Hack · Track: Payments & Monetization · 3 days.
Golden path: brand swipes → creator accepts → chat → agreement → Payaza funds → creator posts → Claude verifies → brand approves → Payaza pays out.

**Workflow:** take the next unchecked task → build it → run its check → tick it → update *Last completed* → commit.

## Last completed
**Task 10b: Email via Brevo** (2026-10-08)
- `MailService` (`src/mail`) sends branded HTML through the Brevo transactional API. Without `BREVO_API_KEY` (tests) mail goes to an in-memory `outbox`. Sending is best-effort: in-app notifications remain the source of truth.
- `OtpCode` model holds 4-digit codes (matching the mobile `CodeInput`), bcrypt-hashed, 15-min expiry, 5 attempts, single use; only the newest code is valid.
- Endpoints: `POST /auth/send-verification`, `POST /auth/verify-email` (a code is sent automatically on register), `POST /auth/forgot-password` (always 204, so it can't reveal which emails exist), `POST /auth/verify-reset-code`, `POST /auth/reset-password` (revokes every session).
- Notifications of kind agreement/funding/payout/dispute/review are also emailed.
- **Needs**: the sender `louisdiaz43@gmail.com` must be a verified sender in Brevo, or Brevo rejects the mail.
- Verified: `test/email-codes.e2e-spec.ts` (wrong code, single use, no enumeration, reset revokes refresh tokens). 16/16 e2e tests pass.

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
- [x] 9. Verification worker: yt-dlp/oEmbed metadata + ffmpeg frames + Groq Whisper transcript → Azure OpenAI → PASS/PARTIAL/FAIL/NEEDS_REVIEW.
- [x] 10. Review (approve → payout, revision, dispute) + admin API (users, campaigns, transactions, webhook replay, verifications, disputes).
- [x] 10b. Email via Brevo: signup verification code, forgot/reset password (6-digit codes, hashed, 15-min expiry), money emails (funded, payout sent/failed).
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
