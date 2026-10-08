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
