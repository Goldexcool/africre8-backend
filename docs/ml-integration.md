# NestJS–FastAPI ML integration

NestJS owns authentication, campaign access, database reads, and the public API. It maps versioned `CreatorMlProfile`, `OpportunityMlProfile`, and isolated `DemoMlEvidenceEvent` rows into the strict FastAPI contract. FastAPI remains stateless and runs the accepted recommendation and credibility algorithms; sponsored placements are returned separately and never alter organic scores.

## Configuration and startup

Use process-scoped environment variables so existing environment files remain unchanged. These commands target only the isolated demo database:

```powershell
$env:DATABASE_URL = 'postgresql://<demo-user>:<demo-password>@127.0.0.1:55432/<demo-database>'
$env:ML_SERVICE_URL = 'http://127.0.0.1:8001'
$env:ML_REQUEST_TIMEOUT_MS = '20000'
$env:ML_SEMANTIC_TIMEOUT_MS = '60000'
$env:JWT_ACCESS_SECRET = '<local-demo-jwt-secret-at-least-32-characters>'
$env:REDIS_URL = 'redis://127.0.0.1:6379'
$env:PAYMENT_PROVIDER = 'mock'
```

Start FastAPI in terminal 1 using the existing environment and local model assets:

```powershell
Set-Location services/ml
.\.venv\Scripts\python.exe -m uvicorn africre8_ml.api.app:app --host 127.0.0.1 --port 8001
```

Start the existing Redis dependency and NestJS in terminals 2 and 3:

```powershell
docker run --name africre8-demo-redis --rm -p 6379:6379 redis:7-alpine
npm run start:dev
```

Confirm readiness without mutating data:

```powershell
Invoke-RestMethod http://127.0.0.1:8001/health
Invoke-RestMethod http://127.0.0.1:8001/ready
Invoke-RestMethod http://127.0.0.1:3000/health
```

## Authenticated end-to-end verification

Imported demo accounts intentionally have unusable passwords. For local verification, select one imported opportunity owner and mint a short-lived token with the same local-only JWT secret. These commands only read the isolated database and do not change an account:

```powershell
$pair = (docker exec africre8-demo-postgres psql -U africre8_demo -d africre8_demo -tAc 'SELECT o.id || ''|'' || o."brandId" FROM "Opportunity" o JOIN "OpportunityMlProfile" m ON m."opportunityId"=o.id ORDER BY m."sourceOpportunityId" LIMIT 1').Trim().Split('|')
$opportunityId = $pair[0]
$brandId = $pair[1]
$creatorId = (docker exec africre8-demo-postgres psql -U africre8_demo -d africre8_demo -tAc 'SELECT "creatorId" FROM "CreatorMlProfile" ORDER BY "sourceCreatorId" LIMIT 1').Trim()
$token = node --input-type=module -e "import { JwtService } from '@nestjs/jwt'; console.log(new JwtService({ secret: process.env.JWT_ACCESS_SECRET, signOptions: { expiresIn: '15m' } }).sign({ sub: process.argv[1], role: 'BRAND' }))" $brandId
$headers = @{ Authorization = "Bearer $token"; 'x-request-id' = 'local-demo-check' }
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/opportunities/$opportunityId/recommendations" -Headers $headers -ContentType 'application/json' -Body '{"mode":"structured","limit":10,"includeExcluded":true,"includeCredibility":true}'
Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:3000/creators/$creatorId/credibility" -Headers $headers
```

Use `tfidf_hybrid` or `semantic_hybrid` in the same request to exercise the other accepted rankers. The first semantic call loads the local E5 model and can take materially longer, so it uses the separate semantic timeout.

## Public contract and failure behavior

`POST /opportunities/:id/recommendations` is restricted to an onboarded brand that owns the opportunity. Its body accepts `mode`, `limit`, `includeExcluded`, and `includeCredibility`. `GET /creators/:id/credibility` allows an onboarded creator to view their own score, an administrator to inspect any creator, and an onboarded brand to inspect active creators open to invitations. Both routes require the existing bearer token.

NestJS returns 404 for inaccessible resources, 409 when an opportunity is closed or lacks ML features, 400 for invalid input, 503 for an unavailable or timed-out ML service, and 502 for an invalid ML response. FastAPI should be bound to a private interface in deployed environments; this phase does not add service-to-service credentials.

## Verification

```powershell
npm run build
npm run lint
npx vitest run test/ml.client.spec.ts test/ml.service.spec.ts test/demo-import.spec.ts
Set-Location services/ml
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```
