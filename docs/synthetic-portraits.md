# Synthetic creator portrait pipeline

The pipeline maps each of the 500 demo-v2 creators to one fictional-adult portrait, validates a 512×512 WebP, uploads only a complete unique set to `africre8/demo/creators/`, and then updates only provenance-marked synthetic creator profiles. Generated files, credentials, manifests, and upload URL maps are local and Git-ignored.

## Plan and cost approval

The supported provider is the OpenAI Images API. Defaults are `gpt-image-1`, medium quality, 1024×1024 provider output, then local 512×512 WebP optimization. OpenAI documents an approximate $0.07 cost for a medium-quality square `gpt-image-1` image, so the configured estimate is $35 for 500, plus minor prompt-token variance. Recheck current pricing before approval: <https://openai.com/index/image-generation-api/>.

```powershell
npm run portraits:plan
```

No paid call occurs in plan mode. Generation additionally requires `OPENAI_API_KEY` and a cost ceiling at least as high as the displayed estimate:

```powershell
$env:OPENAI_API_KEY = '<set locally; never commit>'
$env:PORTRAIT_MODEL = 'gpt-image-1'
$env:PORTRAIT_QUALITY = 'medium'
$env:PORTRAIT_CONCURRENCY = '2'
npm run portraits:generate -- --approve-max-usd=35
npm run portraits:verify
```

The resumable manifest is `services/ml/generated/portraits/manifest.json`. Successful files are skipped on rerun. The generator retries provider failures up to five times, honors `Retry-After`, and otherwise uses exponential backoff. Verification rejects missing/corrupt files, non-WebP content, dimensions other than 512×512, and duplicate SHA-256 hashes. Sharp starts at WebP quality 84 and reduces quality when needed to target at most 150 KB; the preferred 50–150 KB range is reported rather than achieved by artificial padding.

At the requested 50–150 KB range, 500 images should occupy approximately 25–75 MB before storage-provider overhead. This is an estimate until real outputs exist. Technical verification cannot prove that a face is fictional or rule out resemblance to every real person; review generated contact sheets or samples for composition, artifacts, stereotypes, accidental text/logos, and recognizable likenesses before upload.

## R2 upload and database activation

Configure the existing R2 variables locally. Upload is refused unless all 500 files are valid and unique and both the switch and confirmation phrase are present:

```powershell
$env:PORTRAIT_R2_UPLOAD_ENABLED = 'true'
npm run portraits:upload -- --confirm-upload=UPLOAD_VALIDATED_SYNTHETIC_PORTRAITS
$env:PORTRAIT_R2_UPLOAD_ENABLED = 'false'
```

Objects use `image/webp`, immutable caching, content hashes, and stable keys. Upload state is saved after each object so a retry does not repeat completed uploads.

After verifying several `/media/africre8/demo/creators/<creator-id>.webp` URLs, apply URLs to a confirmed database target. The command resolves creators through synthetic consolidation provenance and cannot select retained production creators:

```powershell
$env:PORTRAIT_DATABASE_APPLY_ENABLED = 'true'
npm run portraits:apply-db -- --confirm-target-fingerprint=<reviewed-fingerprint> --confirm-apply=APPLY_UPLOADED_SYNTHETIC_PORTRAITS
$env:PORTRAIT_DATABASE_APPLY_ENABLED = 'false'
```

Keep the SVG route as the default until upload and activation finish. Do not set database URLs to local file paths. Production R2 and Railway execution require separate administrator approval.
