# AfriCre8 production and synthetic data consolidation

## Architecture

The consolidated dataset uses existing operational tables as the source of truth for identity, authentication, relationships, campaigns, and finance. Recommendation attributes remain in the additive ML tables. All recommendation candidates and opportunities converge on namespace `africre8-unified-v1`, allowing one candidate pool without changing operational primary keys.

`DatasetConsolidationRun` records the reviewed plan hash, production snapshot fingerprint, public synthetic dataset fingerprint, target database fingerprint, scope, reconciliation counts, conflicts, backup reference, and completion status. `DatasetRecordProvenance` records whether each consolidated creator, brand, or opportunity came from production, an identity mapping, or an explicitly approved synthetic identity.

`featureProvenance` and `dataQuality` on ML profiles identify operational, parsed, defaulted, and synthetic feature sources. Private generator truth is neither read by the consolidation engine nor stored.

## Field precedence and mapping

| Final data | Production source | Synthetic source | Precedence and treatment |
|---|---|---|---|
| User ID, email, phone, password and role | `User` | Approved new demo identity only | Production always wins. Mapped identities never change authentication. New synthetic accounts have `.invalid` email addresses and unusable passwords. |
| Creator display profile | `CreatorProfile` | Approved new synthetic creator | Existing profile wins. A mapped synthetic creator supplies only ML attributes. |
| Creator category and niches used by NestJS | `CreatorProfile` | New synthetic creator profile | Existing values are retained. |
| Languages, audience, styles and capabilities | Existing `CreatorMlProfile` or operational derivation | Reviewed demo-v2 creator | Reviewed mapping may populate ML-only attributes; provenance marks them synthetic. |
| Creator rates | Operational starting price | Reviewed demo-v2 rate card | Operational profiles receive a generic platform rate. Reviewed synthetic ML features retain their explicit demonstration rate version. |
| Brand account/profile | `User` and `BrandProfile` | Approved new synthetic brand | Existing identity wins. New synthetic brands are provenance-labelled. |
| Opportunity identity, owner, title and brief | `Opportunity` | Approved new synthetic opportunity | Existing opportunity wins for mapped records. New records require an approved or mapped brand. |
| Opportunity ML constraints | Parsed operational deliverables | Reviewed demo-v2 opportunity | Operational text is parsed only when platform is explicit. Reviewed mappings supply ML-only campaign attributes. |
| Applications, matches and conversations | Operational tables | None by default | Retained unchanged. The consolidation engine does not fabricate engagement. |
| Campaigns, requirements and submissions | Operational tables | None by default | Retained unchanged. |
| Transactions, payouts and webhooks | Operational tables | None | Retained unchanged and never written by consolidation. |
| Credibility evidence | Existing reviewed evidence requires manual provenance decision | Explicitly scoped evidence for new synthetic identities only | Synthetic evidence cannot attach to a retained real identity. No operational achievement is inferred. |

## Approved scope

The scope file is the human-reviewed decision record. Start with `prisma/consolidation/scope.example.json` and keep the production copy outside source control.

- `syntheticCreatorIds`, `syntheticBrandIds`, and `syntheticOpportunityIds` approve new demo identities.
- Identity mappings connect one synthetic source record to one known production primary key without overwriting the production account or profile.
- `syntheticEvidenceCreatorIds` is a stricter subset of newly synthetic creators. Every referenced opportunity must also be approved or mapped.
- Empty arrays produce a production-only consolidated dataset.

The dry run rejects unknown IDs, duplicate scope IDs, contradictory new-and-mapped identities, missing mapping targets, ambiguous operational deliverables, unreviewed evidence, and unrelated email ownership.

## Controlled reconciliation

The engine never drops, truncates, or resets tables. It performs deterministic upserts for approved records. To make recommendation attributes converge, it replaces audience-market, capability, and rate child rows only for creator ML profiles included in the reviewed unified plan. Those deletes are scoped by ML-profile primary key and occur inside the same transaction as recreation.

Writes require exact target label, database fingerprint, production snapshot fingerprint, plan hash, restored-backup reference, and confirmation phrase. Batches contain at most 50 records. A failed batch can be retried; provenance and source unique keys prevent duplicate identities.

## Known production-dependent decisions

No Railway production snapshot was accessed during development. The administrator must still review:

- actual duplicate email and identity candidates;
- existing ML profiles and any evidence attached to retained real creators;
- opportunities whose deliverable text does not identify a platform;
- whether any synthetic identities or evidence are approved at all;
- the provisional `1 USD = 1,500 NGN` comparison rate;
- whether production campaign, submission, verification, dispute, and rating events are sufficiently audited for a future real-evidence credibility adapter.

Until the last item is designed and reviewed, real creators with no accepted evidence correctly return `insufficient_evidence`.
