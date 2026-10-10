# Shared synthetic creator portrait pool

AfriCre8 uses a zero-cost pool of exactly 10 locally generated fictional African creator portraits for the 500 demo-v2 creators. Each portrait serves exactly 50 synthetic profiles. Assignment is deterministic: creators are sorted by category and stable ID hash, grouped in fifties, and each slot records its represented categories and common niches.

## Local assets and optimization

Supply `portrait-001` through `portrait-010` as `.png`, `.jpg`, `.jpeg`, or `.webp` under the directory `services/ml/generated/portrait-pool/source/`. Use fictional adults only, with no celebrity likenesses, production-user photos, logos, or watermarks. Review `npm run portrait-pool:plan` first; it reports the categories and representative niches for each slot.

```powershell
npm run portrait-pool:plan
npm run portrait-pool:optimize
npm run portrait-pool:verify
```

Optimization produces 512×512 WebP files under `services/ml/generated/portrait-pool/optimized/`. Verification requires 10 valid, distinct content hashes and 500 balanced assignments. The ten PNG source portraits, ten optimized WebP portraits, and contact-sheet preview can be committed to Git. The machine-specific manifest and temporary helper files remain ignored.

## R2 and display overrides

Validated objects use stable keys `africre8/demo/portrait-pool/portrait-001.webp` through `portrait-010.webp`. Upload is disabled unless all 10 assets pass verification and the administrator supplies the explicit switch and confirmation:

```powershell
$env:PORTRAIT_POOL_R2_UPLOAD_ENABLED = 'true'
npm run portrait-pool:upload -- --confirm-upload=UPLOAD_VALIDATED_10_PORTRAITS
$env:PORTRAIT_POOL_R2_UPLOAD_ENABLED = 'false'
```

After sampled media URLs work, apply the pool to a fingerprint-confirmed database. This writes `CreatorMlProfile.displayImageOverrideUrl`; it never changes `CreatorProfile.avatarUrl` or portfolio data. A separately reviewed `{ creatorId: portraitId }` JSON map can supply demo-only retained-production overrides through `--production-overrides=<path>`.

```powershell
$env:PORTRAIT_POOL_DATABASE_APPLY_ENABLED = 'true'
npm run portrait-pool:apply-db -- --confirm-target-fingerprint=<reviewed-fingerprint> --confirm-apply=APPLY_10_PORTRAIT_POOL
$env:PORTRAIT_POOL_DATABASE_APPLY_ENABLED = 'false'
```

Creator-card responses resolve the display override first and otherwise return the stored avatar or SVG fallback. The previous 500-image OpenAI pipeline remains for potential future use, but paid generation additionally requires `PORTRAIT_INDIVIDUAL_GENERATION_ENABLED=true` and `--confirm-individual-generation=GENERATE_500_INDIVIDUAL_PORTRAITS`. Keep it disabled for the shared-pool workflow.
