# AfiCre8 backend — build plan

Hackathon: The Fusion Hack · Track: Payments & Monetization · 3 days.
Golden path: brand swipes → creator accepts → chat → agreement → Payaza funds → creator posts → Claude verifies → brand approves → Payaza pays out.

**Workflow:** take the next unchecked task → build it → run its check → tick it → update *Last completed* → commit.

## Last completed
**Task 11: Railway deploy** (2026-10-08)
- Project `africre8-backend` (https://railway.com/project/e92035a8-ef25-4a4f-b46e-2da64fb9fab6). Services `api`, `worker`, `Redis`, all in **us-east4**, next to Neon.
- **API URL: https://api-production-4030.up.railway.app**. Payaza webhook: `https://api-production-4030.up.railway.app/webhooks/payaza`.
- Both services run one Dockerfile image (`railway.json` forces the DOCKERFILE builder). `PROCESS=worker` selects the worker. The API runs `prisma migrate deploy` on boot.
- Variables come from `.env` per service, plus `REDIS_URL=${{Redis.REDIS_URL}}` (private network) and `PUBLIC_URL`.
- Deploy: `railway up --service api --detach` and `railway up --service worker --detach`.
- SSH: `ssh -i ~/.ssh/railway_africre8 <service-user>@ssh.railway.com` (`railway ssh config --service worker` prints the block).
- Verified in production:
  - `/health` returns db up; demo brand login works; migrations applied
  - **a real TikTok runs through yt-dlp → 6 ffmpeg frames → Groq Whisper transcript → Azure gpt-5.3-chat in about 12s**, with correct pass/fail plus frame and transcript evidence
- Known limitation: YouTube blocks datacenter IPs. Metadata still works through oEmbed; for frames and audio set `YTDLP_COOKIES` (cookies.txt contents). TikTok works without it.

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
- [x] 11. Railway deploy (api + worker + redis), migrate, seed; set Payaza webhook URL.
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

## Additions (2026-10-08, mobile redesign)
- [x] 13. Campaign briefs (`Opportunity`): PUBLIC (listed to creators, `applicationLimit` cap) / PRIVATE (invite-only), DRAFT/PUBLISHED/CLOSED. `POST/PUT /opportunities`, `/opportunities/mine` (counts + slots left), `/opportunities/feed` (creator), `/opportunities/:id/apply`, publish/close.
- [x] 14. Interests and swipes scoped per brief (`scopeKey`); an invite/application carries `opportunityId` + `message`. `POST /interests/bulk` (stack send). `/interests/:id/respond` answered by the receiver (creator for invitations, brand for applications). Accepting creates or reuses the connection, records the brief, and posts the note as the first message.
- [x] 15. Inbox data: `/matches` returns the brief, latest campaign stage, last message and unread count; `POST /conversations/:id/read`. Creators' `openToInvites` hides them from Discover. Verified: `test/opportunities.e2e-spec.ts`, 19/19 e2e.

---

## Mobile alignment (branch `feat/mobile-alignment`)
- [x] 16. Global exception filter, uniform `{ statusCode, message, code, errors? }`, no 500 leaks.
- [x] 17. User-friendly wording for technical errors; stable error `code`s.
- [x] 18. e2e tests green after message changes.

### Still open in the backend (found in review)
- `app.enableCors()` is fully open; no `helmet`.
- No request logging / structured logs.
- No push notifications (notifications are DB + socket only); no device-token endpoint.
- No endpoints for: account deletion, change password while signed in, update email/phone.
- Admin API exists but there is no admin web UI.
- YouTube verification blocked on datacenter IPs (needs `YTDLP_COOKIES`).
- Payaza payout account must be set up in the Payaza dashboard before real payouts; confirm `PAYMENT_PROVIDER=payaza` (default is `mock`) on Railway.
- [x] 19. Rate limiting on auth/OTP endpoints (login, register, forgot-password, verify-email, verify-reset-code, reset-password, refresh). Generous enough for the app's retries and QA runs.

### Mobile alignment: backend work done (2026-10-08, branch `feat/mobile-alignment`, uncommitted)
**Error contract.** Every error is now `{ statusCode, message, code, errors? }` (`src/common/all-exceptions.filter.ts`, registered as `APP_FILTER`).
- `message` is always safe to show a user. 5xx and unexpected errors return `An unknown error occurred, try again.` (real error logged server-side only). Nest defaults ("Forbidden", "Cannot GET /x") are replaced.
- `code` is stable and listed in `src/common/errors.ts` (`ErrorCode`): UNAUTHENTICATED, SESSION_EXPIRED, INVALID_CREDENTIALS, ACCOUNT_SUSPENDED, FORBIDDEN, WRONG_ROLE, ONBOARDING_REQUIRED, VALIDATION_ERROR, NOT_FOUND, CONFLICT, CAMPAIGN_WRONG_STAGE, CAMPAIGN_CHANGED, PAYMENT_PENDING, RATE_LIMITED, INVALID_CODE, INTERNAL_ERROR.
- Validation errors (`ZodPipe`) return `code: VALIDATION_ERROR` and `errors: [{ path, message }]` per field.
- Campaign stage conflicts use `wrongStage()` (plain wording such as "This campaign is under review, so you can't do that right now.") instead of raw status names.
- Token reuse / invalid / expired refresh tokens all say `Your session has expired. Please sign in again.` (`SESSION_EXPIRED`).
- Sockets keep their own `WsException` handling.

**Rate limiting.** `@nestjs/throttler` on `AuthController` (all auth endpoints except `GET /auth/me`): per-IP, 60s window, limit from env `RATE_LIMIT_PER_MINUTE` (default 20). Skipped when `NODE_ENV=test`. `main.ts` sets `trust proxy` so Railway's proxy IP is not used for every client. Exceeding it returns 429 `RATE_LIMITED`.

**Tests.** `test/errors.e2e-spec.ts` (6 tests: shapes, field errors, no framework text, role, token reuse, 429). Old assertions on technical wording in campaigns/payments e2e updated. `npm run test:e2e` fixed for the installed dotenv-cli (`dotenv run -f .env.test -- ...`); it needs `SEED_ADMIN_PASSWORD` in the environment for the golden-path test, with the DB seeded.

**Result:** e2e 25/25 on the local Docker Postgres (`.env.test`, never production).

**Deploy notes:** set `RATE_LIMIT_PER_MINUTE` on Railway if you want a value other than 20. No migration needed.

**Seed change (mobile alignment):** `prisma/seed.ts` now sets `emailVerifiedAt` on demo accounts (create and update) because the mobile app requires a verified email. The server itself still does not enforce email verification (decision: app-only gate). Re-run the seed on existing databases.

### Planned for mobile Phase D (see frontend/docs/plan.md)
- [x] 20. `GET /meta/filters` (categories, locations, platforms, availability, NGN budget presets) with Cache-Control + ETag.
- [ ] 21. `POST /uploads/sign`: Cloudflare R2 presigned PUT when `CLOUDINARY_URL` is unset (env `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, public base URL TBD).
- [x] 22. Not needed: `/auth/me` already returns `payoutDestination` (confirmed in the D1 audit).
- [ ] 23. Message pagination for `GET /conversations/:id/messages`, if needed.

**Mobile Phase D (D3):** `POST/PUT /opportunities` and `POST /opportunities/:id/publish|close` now return the same view as list/detail (adds `budgetNgn` next to `budgetKobo`); e2e asserts it. The "creators can turn off invitations" e2e test no longer depends on how many creators exist.
