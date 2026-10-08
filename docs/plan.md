# AfiCre8 backend — build plan

Hackathon: The Fusion Hack · Track: Payments & Monetization · 3 days.
Golden path: brand swipes → creator accepts → chat → agreement → Payaza funds → creator posts → Claude verifies → brand approves → Payaza pays out.

**Workflow:** take the next unchecked task → build it → run its check → tick it → update *Last completed* → commit.

## Last completed
**Task 1: Scaffold.**
- NestJS 12 (ESM) + Prisma 7.10 (pg adapter) on Neon. Full domain schema migrated (21 tables) plus partial unique indexes: one live payout and one live funding per campaign.
- Env validated with zod (`src/config/env.ts`). `GET /health` checks the DB.
- Verified: `npm run build`, `npm run lint`, `npm run test:e2e` (health → db up).

## Stack
NestJS · Prisma/Postgres (Neon) · Redis + BullMQ (separate worker process) · Socket.IO · Cloudinary · Payaza · Claude (`claude-sonnet-5-5`) · Docker + nginx · Railway.

## Tasks
- [x] 1. Scaffold Nest + Prisma (Neon) + env validation + `/health`. Push to GitHub.
- [ ] 2. Dockerfile (api + worker from one image) + docker-compose (nginx → api, worker, redis). Check: `docker compose up`, `curl localhost/health` via nginx.
- [ ] 3. Auth: register/login, access JWT (15m) + rotating refresh tokens (hashed, family reuse detection), logout, RolesGuard, onboarding guard. Check: e2e covers rotation + reuse revoking the family.
- [ ] 4. Profiles (creator/brand/socials/payout destination), Cloudinary signed upload, seed (30 creators, 3 brands, 1 admin).
- [ ] 5. Discovery (filters, excludes swiped/unavailable) + swipe + interest (expiry) + accept/decline → match + conversation.
- [ ] 6. Socket.IO gateway (JWT auth, match-member rooms, chat) + notifications (DB + socket).
- [ ] 7. Campaigns: create/edit terms (version bump resets acceptance), bilateral accept, state machine + AuditLog.
- [ ] 8. Payments: PaymentProvider (Mock + Payaza TEST), fund, webhook (signature, dedupe, re-query), reconcile job, payout, banks + name enquiry.
- [ ] 9. Verification worker: YouTube Data API + TikTok oEmbed + yt-dlp/ffmpeg frames → Claude → PASS/PARTIAL/FAIL/NEEDS_REVIEW.
- [ ] 10. Review (approve → payout, revision, dispute) + admin API (users, campaigns, transactions, webhook replay, verifications, disputes).
- [ ] 11. Railway deploy (api + worker + redis), migrate, seed; set Payaza webhook URL.
- [ ] 12. Golden-path e2e (`test/golden-path.e2e-spec.ts`, MockProvider): duplicate webhook ⇒ one payout; failed payout stays `payout_failed`.

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
