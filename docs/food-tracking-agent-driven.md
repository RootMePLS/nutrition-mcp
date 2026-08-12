# Agent-driven food tracking contract

This document describes the contract implemented by this repository at the
`nutrition-mcp` boundary. It is deliberately narrower than a Telegram bot or
provider integration: the server stores and validates prepared inputs; the
agent host owns ingestion and orchestration.

## Architecture boundary

**Hermes (the agent host) owns** transport receipt (for example, chat text,
photo, or voice), byte staging through its own capabilities, parsing and
clarification questions, evidence precedence decisions, its `own` estimate,
calls to `nutrition-local` and MyFitnessPal MCP tools, uncertainty
explanations, and interpreting an explicit user confirmation.

**nutrition-mcp owns** transport-neutral PostgreSQL capture/event/version state,
raw message/answer/evidence/media metadata, validation of prepared drafts and
calculation bundles, server-derived identity and idempotency, atomic local
persistence, append-only corrections, backend canonical recomputation, and
honest provider/sync status.

This checkout has **no Telegram bot/webhook/polling, STT, OCR, vision, LLM or
parser, direct external-MCP caller, autonomous worker/cron, or production
provider credential**. `nutrition-mcp` does not download or interpret a photo or
audio attachment. It receives the agent's prepared text, metadata, media
provenance, and provider results.

The runtime is single-user and has no authentication layer. MCP handlers use
the configured `SINGLE_USER_ID` (the default application identity) for ordinary
nutrition tools; capture/event operations additionally require the supplied
`user_id` and scope every read/write by that identity. The food cache is the
intentional shared exception. This is not a multi-tenant authorization claim.

## Capture lifecycle

A host can use the additive MCP tools:

- `start_meal_capture`
- `append_meal_capture_message`
- `answer_meal_capture`
- `attach_meal_capture_media`
- `save_meal_capture_draft`
- `get_meal_capture`
- `cancel_meal_capture`
- `expire_meal_capture`
- `confirm_meal_capture`

The durable states are `receiving → ready_to_confirm → confirmed`, with
`cancelled` and `expired` terminal alternatives. Messages, answers, and media
metadata survive process boundaries. Mutations lock the capture row and replay
of the same identity is idempotent; reads and mutations reject another user's
capture.

`confirm_meal_capture` is a commit gate, not a suggestion: the confirmation
must be an explicit add command. The Russian command **`добавь`** is accepted,
as are the implemented `add` and `confirm` equivalents. A capture without
confirmation cannot create the event. Confirmation derives the event key as
`capture:<capture_id>`; a successful retry returns the original capture/event
IDs rather than creating another root.

## Raw evidence and media provenance

The host supplies raw message metadata and prepared evidence. Evidence is
stored, not silently discarded, with precedence:

`user_text > audio_transcript > photo_ocr > photo_vision > model_assumption`.

The server does not produce those transcripts or interpretations. Capture media
stores metadata only in PostgreSQL (`kind`, generated `storage_key`, MIME,
byte size, SHA-256, optional duration/dimensions, and caller metadata). Bytes
remain under `MEDIA_ROOT`. No media bytes are placed in JSONB and no stored
metadata is proof that OCR/STT/vision ran.

`attach_meal_capture_media` is how bytes arrive: Hermes sends base64
(`bytes_base64`, 8 MiB decoded cap) plus `kind` and `mime_type`; the backend
owns everything else. It enforces the exact MIME allow-list
(`image/jpeg`, `image/png`, `image/webp`, `audio/ogg`, `audio/mpeg`,
`audio/mp4`), computes SHA-256 server-side from the decoded bytes (an optional
caller-supplied `sha256` must match the server hash or the call fails),
generates the capture-scoped content-addressed key
`capture/<capture_id>/<kind>-<sha256>` — the caller can never set
`storage_key` — stages the file through the process-wide `MediaStore`
(`MEDIA_ROOT`, default `var/media`), then inserts the row in a transaction.
On any transactional rollback the staged file is deleted, so a failed attach
leaves neither row nor file; re-attaching identical bytes is idempotent and
returns the existing identity with `deduplicated: true`. Attaches are
user-scoped and only allowed while the capture is editable
(`receiving`/`ready_to_confirm`). A prepared draft's `media` entries must echo
the returned identity fields exactly, or `confirm_meal_capture` rejects the
draft for media provenance mismatch.

## Calculation bundles and uncertainty

The host submits `validate_calculation_bundle` or
`commit_calculation_bundle` with event/version context, resolved item/evidence
input, and one result per provider/scope. The implemented providers are
`nutrition-local`, `own`, and `myfitnesspal`. Every result carries a
`source_id`, status (`succeeded`, `failed`, or `unavailable`), request
fingerprint, algorithm/model version, basis/units, raw payload, and nutrient
values where available. Missing, failed, and unavailable nutrients stay
`null`; they are never silently converted to zero.

The bundle fingerprint is recomputed from the resolved inputs/evidence and
provider results (with stable provider ordering); a mismatch is rejected. The
backend, not the agent proposal, recomputes canonical nutrition using the
existing `computeConsensus` policy, recorded as `consensus-10pct-v1`. Canonical
rows are materialized per scope: consensus is computed independently for the
event scope and for each item ordinal, one canonical row is persisted per scope
(`scope_key` `event`, `item:0`, ...), and each row's `source_result_ids` reference
only succeeded provider rows of the same scope — an item-scoped value can never
move the event canonical. The `commit_calculation_bundle`,
`commit_calculation_correction`, and `get_calculation_provenance` outputs expose
the event canonical as `canonical` (unchanged) plus one entry per item ordinal in
`item_canonicals`. Canonical rows retain eligible and outlier provider IDs,
source result IDs, threshold and policy metadata, plus correction audit
evidence. A proposal is audit input, not authority. `nutrition-mcp` makes no
provider network calls.

The public `get_calculation_provenance` tool is user-scoped and reads the current
version by default; passing `version` reads immutable history. It returns all
stored provider audit fields (`source_id`, raw payload, provenance, basis, units,
errors), the bundle fingerprint, and canonical audit fields. Its explicit status
is `ready`, `pending`, `unavailable`, or `missing`: compatibility writes from
`log_meal`, bulk import, legacy update, and capture confirmation are pending or
missing until a real bundle is committed. `null` means unavailable evidence,
while an explicitly stored numeric zero remains zero. Deleted and cross-user
events are hidden as not found.

The legacy write tools disclose the same truth on their own outputs. `log_meal`
and `update_meal` payloads and every written `bulk_import_meals` result row
carry `provenance_status` (`compatibility` | `pending` | `complete`),
`event_version`, `has_calculation_bundle`, and a one-line `provenance_note`. A
compatibility write always discloses `compatibility` with
`has_calculation_bundle: false`; only a version with a committed calculation
bundle whose evidence readback is `ready` reports `complete`, and a committed
bundle with incomplete evidence reports `pending`. Import rows that never
reached the database (dry run, failed validation, not attempted) report all
four fields as explicit `null`s — never a fabricated status. All three tools
build the fields from one shared `writeProvenanceFields` mapping over the
persisted write readback, so a deduplicated retry reports the event's current
truth (e.g. `complete` after a bundle lands), never a stale `compatibility`.

## Totals presence contract (NULL vs zero)

The public aggregates (`get_nutrition_summary`, `get_goal_progress`,
`get_trends`, the log/update-meal progress payloads, the MCP Apps widgets, and
the `export_meals` CSV) follow the same null-vs-zero rule as the stored rows.
In every totals payload the four core macros (`calories`, `protein_g`,
`carbs_g`, `fat_g`) are nullable: a total is `null` only when **no** meal in
the selection has a calculated value for that nutrient — pending calculations
and empty days are never coalesced to `0`. A mixed selection sums only the
calculated values, and every totals payload carries the integer counts
`meals_total` and `meals_calculated`, where `meals_calculated` is a
per-nutrient object `{ calories, protein_g, carbs_g, fat_g }` counting how
many meals carry each specific macro — presence differs per nutrient, so a
partial per-nutrient sum is never mistaken for a complete one (calories `2/2`
with protein `1/2` is disclosed as exactly that, never as `2/2` overall). An
explicitly stored `0` stays `0` end to end and counts as coverage for its own
macro. Range averages keep the historical denominator (every logged day) but
are `null` for any core nutrient no day in the window carries — including an
empty range, whose core averages are all `null` with zero counts (water alone
keeps its legacy `0` average). Text progress renders a null total as
`no data yet` (never `0%` of goal, never `NaN`), the widgets render
`—`/`no data yet` for null and `0` only for a real zero, and the CSV export
keeps empty cells for missing values.

`commit_calculation_correction` is the public immutable correction boundary. It
requires a complete validated bundle, explicit confirmation, correction
reason/author/timestamp, user ownership, and idempotency identity. It appends
`current_version + 1`, recomputes canonical values in the backend, preserves
prior rows, and creates only a pending sync journal intent when explicitly
authorized.

## Canonical nutrient expansion (slice 1)

Migration `011_nutrient_expansion.sql` extends the canonical nutrient schema
beyond the seven core fields (`calories` kcal, `protein_g`, `carbs_g`,
`fat_g`, `fiber_g`, `sugar_g`, `alcohol_g`) with eleven first-class
micronutrient and fat-subtype fields. The field-name suffix IS the unit
contract — top-level fields store canonical units only:

| Field                   | Canonical unit |
| ----------------------- | -------------- |
| `saturated_fat_g`       | g              |
| `polyunsaturated_fat_g` | g              |
| `monounsaturated_fat_g` | g              |
| `trans_fat_g`           | g              |
| `cholesterol_mg`        | mg             |
| `sodium_mg`             | mg             |
| `potassium_mg`          | mg             |
| `calcium_mg`            | mg             |
| `iron_mg`               | mg             |
| `vitamin_c_mg`          | mg             |
| `vitamin_a_mcg_rae`     | mcg RAE        |

**Null policy.** Original provider units stay in `raw_payload`/`provenance`
untouched; conversion happens at ingest, never at render. Ambiguous source
units — vitamin A in IU with an unknown form, or any `%DV` value — map to
`null`: preserved in the raw payload, never guessed and never coerced to
`0`. Absent keys and community-corrupt values (non-finite, negative) also
map to `null`. `%DV` values are refused outright in slice 1: converting
them needs a declared DV basis, which is deferred. Callers supplying
`myfitnesspal`, `nutrition-local`, or `own` results must convert to
canonical units before calling `log_meal_event` and omit (send `null` for)
anything ambiguous — never `0` for unknown.

**Open Food Facts mapping** (server-owned, `src/foods.ts`). OFF normalizes
mass nutrients to grams in `*_serving`/`*_100g`:

| OFF key (`_serving`/`_100g`) | Canonical field         | Conversion                                                              |
| ---------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `saturated-fat`              | `saturated_fat_g`       | none (g)                                                                |
| `polyunsaturated-fat`        | `polyunsaturated_fat_g` | none (g)                                                                |
| `monounsaturated-fat`        | `monounsaturated_fat_g` | none (g)                                                                |
| `trans-fat`                  | `trans_fat_g`           | none (g)                                                                |
| `cholesterol`                | `cholesterol_mg`        | g → mg (×1000)                                                          |
| `sodium`                     | `sodium_mg`             | g → mg (×1000)                                                          |
| `potassium`                  | `potassium_mg`          | g → mg (×1000)                                                          |
| `calcium`                    | `calcium_mg`            | g → mg (×1000)                                                          |
| `iron`                       | `iron_mg`               | g → mg (×1000)                                                          |
| `vitamin-c`                  | `vitamin_c_mg`          | g → mg (×1000)                                                          |
| `vitamin-a`                  | `vitamin_a_mcg_rae`     | only when `vitamin-a_unit` is `µg`/`mcg` (×1e6); IU or missing → `null` |

`salt` is NEVER used to derive sodium — OFF already computes `sodium` from
salt, so deriving again would double-convert.

**Daily summary contract.** `get_daily_nutrient_summary(date?)` returns an
MFP-style per-nutrient dashboard for one local day (default: today in the
user's timezone): `{ date, timezone, meal_count, nutrients[],
micronutrient_completeness_percent, notes[] }`. Each nutrient entry carries
`key`, `unit`, `total` (null when no meal had data — never 0-filled),
`goal`, `remaining`, `percent_of_goal`, `completeness_status`
(`high`/`partial`/`low`/`none`), `data_coverage_percent`,
`contributing_meal_count`, and `missing_meal_count`. Totals sum event-scope
canonical results of active meals at their current version. Coverage is
calorie-weighted when every meal of the day has calories, otherwise
meal-count-based; `none` means zero contributors, `high` ≥ 90%, `partial` ≥
50%, else `low`. Macro goals map from the stored nutrition goals; all
eleven new fields return `goal: null` until micronutrient goal storage
ships. An empty day returns a full valid payload with every nutrient
`total: null, status: "none"` — never an error.

## Corrections, retries, and rollback

Corrections append a new event version; historical versions, raw evidence,
provider rows, and canonical evidence are immutable. A correction records its
prior version, correction idempotency key, reason, author, source timestamp,
confirmation flag, bundle fingerprint, and audit evidence. The exact same
correction identity and matching fingerprint returns the existing version. A
reused correction key with different identity or fingerprint is rejected; a
stale version cannot move the current pointer. Changed resolved input (such as
portion or evidence) therefore creates a distinguishable append-only version,
not an in-place edit.

Capture confirmation, event children, bundle rows, canonical rows, correction
rows, and authorization journal writes use database transactions. A database
failure rolls back the transaction as a whole; a provider failure is persisted
as `failed`/`unavailable` and does not erase the local event. Unique keys and
server-derived capture/correction identities make identical retries converge
without duplicate roots, versions, provider rows, or journal intents.

## Confirmed meal reuse

`reuse_meal_calculation` is the explicit-confirmation mutation that creates a
NEW meal event from one precise prior event/version (the exact pair surfaced
by `search_meals` reuse candidates). The server — inside one transaction —
locks the caller's reuse idempotency identity and the requested source
event/version, enforces fail-closed eligibility against the persisted
provenance policy (only an active, caller-owned source whose requested version
re-derives fully ready, non-compatibility evidence is reusable; absent,
deleted, cross-user, nonexistent-version, compatibility, pending, and
unavailable sources are rejected with stable errors that never reveal another
user's data or existence), then copies the server-read source items, provider
evidence, and canonical facts byte-for-byte into a fresh root + version 1 with
the supplied fresh reported/consumed timestamps. It records immutable lineage
(source event/version, source canonical result, source bundle fingerprint,
confirmation flag) plus per-provider source mappings in the reuse lineage
tables. No providers are called, caller-supplied nutrition values are never
accepted, and rejected calls write nothing — never a fabricated zero. An
identical retry converges on the original event; the same key with a changed
source, version, or timestamp is a stable `idempotency_conflict`.

## Supplement product catalogue

`create_supplement_product` registers a supplement or sports-nutrition product
from a verified label only: category `supplement | sports_nutrition`, names and
aliases, serving, the supplied generic nutrient facts (`nutrient_key`, amount,
explicit unit — an explicit numeric zero is real data; an unknown nutrient is
omitted, never zero), label evidence, and optional label-defined limits. It
creates immutable label version 1 and returns the product readback; replaying
the same idempotency key with the same label returns the original product, and
a different label under the same key is a conflict — concurrent first-time
creates are DB-serialized by migrations `008`/`009`.
`revise_supplement_product_label` appends an immutable label version N+1 and
advances the current pointer in one transaction; historical versions, intake
snapshots, and a regimen's pinned version are never rewritten, and deleted
products cannot be revised. `get_supplement_product`,
`list_supplement_products`, and `search_supplement_products` are read-only and
user-scoped: deleted products are excluded (or fail closed as not found), and
case-insensitive search matches only the CURRENT label version's display name,
short name, and aliases — historical-version aliases stop matching after a
revision, and ambiguity is explicit rather than silently resolved.

## Supplement regimens and append-only intake facts

A supplement regimen is declarative intent, created only by the explicit
`create_supplement_regimen` mutation: it binds a caller-owned active product
to one pinned label version (the current version at create time unless an
explicit historical version is given), a positive dose in servings, a
validated schedule (IANA timezone, `daily`/`weekly`, local time, ISO weekdays
for weekly), and a start/end window. `list_supplement_regimens`,
`set_supplement_regimen_active` (the explicit activate/deactivate operation,
idempotent when the state already matches), `resolve_supplement_product`,
`get_supplement_intakes`, and `get_supplement_regimen_status` complete the
family. This repository ships no scheduler, no reminders, and no automatic
intake marking: creating or reading a regimen never writes an intake fact, a
meal event, or a job, and a due occurrence is only ever derived as `undefined`
in a read result.

Intake facts are append-only: `log_supplement_intake` inserts an immutable
fact (exactly one selector — direct product id, unique alias, or an active
regimen id; positive servings; strict ISO-8601 `occurred_at`; state action
`done`/`missed`/`cleared`; a required idempotency key). Facts are never
updated or deleted; a correction appends a new fact carrying actor, reason,
and an optional supersedes link to an earlier same-product fact. The public
visible state is exactly `undefined`, `done`, or `missed`: an absent mark is
`undefined` (never `missed`), and `cleared` projects back to `undefined`, so
the intended cycle is undefined → done → missed → undefined. The raw
`cleared` action survives only as audit `state_action` in history reads. For a
`done` fact, the server immutably snapshots every nutrient of the bound label
version scaled by servings (explicit label zeros scale to zero; unknown
nutrients stay absent) — a later label revision never rewrites intake history
or a regimen's pinned version. Alias resolution is exact and read-only:
ambiguity returns candidates (or fails the log with
`supplement_alias_ambiguous`) with zero writes, and a direct product id
removes ambiguity authoritatively. Unknown, cross-user, or deleted products
and regimens fail closed with the same not-found shape, so existence never
leaks. A confirmed `done` intake of a caloric `sports_nutrition` product atomically —
in the same transaction as the intake fact and snapshots — creates one linked
`snack` meal event through the ordinary append-only event path and one
bidirectional intake↔event link row. The snack's evidence is transparently
label-derived, not a calculation: a single `own` provider result
(`algorithm_version` `label-compat-v1`) whose provenance is
`{ kind: "supplement_label", product_id, product_version, servings }`, carrying
only the food-compatible nutrient keys scaled from the immutable snapshot of
the bound label version (an explicit label zero scales to zero; unknown stays
absent). The public `get_calculation_provenance` re-read reports
`compatibility: true` with `bundle_fingerprint: null` — a label snack never
claims to be a ready three-provider calculation, and no provider is called.
Retries converge on the same event (`snack:suppl-intake:<intake_id>`); a
rolled-back intake leaves no event or link. Ordinary `supplement` products and
`missed`/`cleared` facts never create a meal event. The reporting boundary and
data-flag reads shipped with the reporting slice described next.

## Reporting boundary and non-medical data flags

Two read-only tools expose the Release-2 reporting boundary without crossing
it. `get_supplement_nutrition_summary` returns, for an explicit bounded date
range (at most 92 inclusive days) in an explicit IANA timezone, the food
contribution (current canonical facts of active meal events in range,
excluding supplement-linked snack events so nothing is counted twice — the
excluded count is disclosed), the correction-aware supplement/sports
contribution from immutable done-intake label snapshots (disclosing raw fact,
effective done, and correction-excluded counts), and a combined total grouped
strictly by exact nutrient key + unit with no unit conversion; absent values
stay absent and an explicit stored zero stays 0.
`get_supplement_data_flags` reports transparent data facts only: the same
nutrient key + unit recorded from two or more distinct products, recorded
daily totals compared against a product label's own explicitly stored maximum
where one exists (never a fabricated threshold), and derived past-due
occurrences of active regimens with no recorded state. Both tools are
user-scoped and write nothing on any path, including validation errors, and
neither carries medical, dosage, or interaction advice. This repository only
exposes the data: composing, scheduling, or delivering any report (for
example a periodic summary in Hermes Release 2) happens outside this
repository — no scheduler, no reminders, and no report delivery exist here.

## MyFitnessPal sync journal

An explicit add confirmation authorizes a possible MyFitnessPal write and
creates one durable journal intent with `authorization_source` such as
`explicit_add_intent` and state `pending`. The journal state machine is
`pending → in_flight → succeeded|failed|dead_letter` (with the implemented
transition rules). This repository ships no MyFitnessPal writer: `pending` is
not `synced`, and no external ID or success claim may be invented. Local event
persistence is independent of any later external attempt. A correction uses a
separate correction journal identity and remains pending under the same rule.

## Release 1 scope boundary

This repository stores, validates, and reads back nutrition truth; the agent
host owns everything conversational and external.
It does not deliver or schedule weekly reports — the reporting tools are query
boundaries only. There
is no cron, scheduler, or reminders, and the server
never marks an intake automatically; a due regimen occurrence is only ever derived as `undefined` in
a read result. It has no OCR or image parsing and offers
no medical, dosage, or interaction advice — the data flags are transparent recorded facts. Reuse
and snack linkage copy stored evidence and
never re-runs or calls external nutrition providers, and it ships no MyFitnessPal writer: explicit
authorization records a pending journal intent only.

## Migrations, upgrade, and test gate

Apply the forward-only migrations in this exact order:

1. `db/migrations/001_initial_schema.sql` — base local PostgreSQL schema.
2. `db/migrations/002_food_tracking.sql` — append-only event/evidence/provider
   substrate; **destructively deletes the legacy `meals` rows/table**. Export
   first. There is no rollback or backfill for that reset.
3. `db/migrations/003_meal_captures.sql` — durable capture/messages/answers/media.
4. `db/migrations/004_calculation_bundles.sql` — bundle source/provenance and
   version fingerprint columns.
5. `db/migrations/005_calculation_corrections.sql` — immutable correction and
   canonical audit columns.
6. `db/migrations/006_meal_reuse_and_supplements.sql` — additive meal-reuse
   lineage and supplement/sports-nutrition catalogue substrate (products,
   immutable label versions, aliases, generic nutrients, label limits,
   declarative regimens, append-only intake facts, nutrient snapshots, and
   intake↔snack links). The public tools over these tables shipped in the
   catalogue, regimen/intake, snack-linkage, and reporting slices.
7. `db/migrations/007_ownership_lineage_integrity.sql` — additive integrity
   hardening over the 006 substrate: composite candidate keys and foreign
   keys that make cross-user reuse lineage, mismatched provider-source
   mappings, cross-user product/regimen/intake rows, and uncorrelated intake
   snapshots/meal links impossible at the database boundary.
8. `db/migrations/008_supplement_create_idempotency.sql` — additive partial
   unique index `uniq_spv_user_create_idem` on
   `supplement_product_versions (user_id, revision_idempotency_key)
WHERE version = 1 AND revision_idempotency_key IS NOT NULL`, which makes
   concurrent first-time product creates with the same key serialize at the
   database: exactly one root/version-1 commits per (user, key); the loser
   converges as a deduplicated read or a stable `idempotency_conflict`.
   Null keys stay non-unique and different users never collide.
9. `db/migrations/009_supplement_create_idem_reconciliation.sql` — additive,
   forward-safe remediation for 008 (which is pushed and immutable): a
   001–007 database carrying pre-008 race duplicates cannot build 008's
   index. 009 first reconciles every duplicate non-null `(user_id,
version = 1, revision_idempotency_key)` group deterministically — the
   oldest `created_at` version-1 row wins (ties broken by lowest
   `product_id`) and keeps the key; each losing version-1 row's key is set
   to NULL while its product root, version row, and all child label facts
   stay fully readable — and appends one row per decision to
   `supplement_create_idem_reconciliation_audit` (migration, user, original
   key, winner/loser product+version, decision, reason, timestamp;
   idempotent via a unique constraint, never duplicated on rerun). Only
   then does it create the same index `IF NOT EXISTS`. A database stuck at
   008's `could not create unique index` failure reaches head by applying
   009 and then re-applying 008, which succeeds as a no-op.
10. `db/migrations/010_supplement_regimen_idempotency.sql` — additive and
    rerun-safe: a nullable `idempotency_key` column on `supplement_regimens`
    plus a partial unique index `uniq_supplement_regimens_user_idem` on
    `(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL`, so
    concurrent first-time regimen creates with the same key serialize at the
    database exactly like product creates do under 008. Null keys stay
    non-unique and different users never collide.
11. `db/migrations/011_nutrient_expansion.sql` — additive and rerun-safe:
    eleven nullable `numeric` micronutrient / fat-subtype columns
    (`saturated_fat_g`, `polyunsaturated_fat_g`, `monounsaturated_fat_g`,
    `trans_fat_g`, `cholesterol_mg`, `sodium_mg`, `potassium_mg`,
    `calcium_mg`, `iron_mg`, `vitamin_c_mg`, `vitamin_a_mcg_rae`) on both
    `meal_event_nutrition_results` and `meal_event_canonical_results` via
    `ADD COLUMN IF NOT EXISTS`. No defaults, no backfill; old rows read as
    NULL. Must be applied to production BEFORE any code release that writes
    or reads these columns.

For a new database:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_initial_schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/002_food_tracking.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/003_meal_captures.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/004_calculation_bundles.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/005_calculation_corrections.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/006_meal_reuse_and_supplements.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/007_ownership_lineage_integrity.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/008_supplement_create_idempotency.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/009_supplement_create_idem_reconciliation.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/010_supplement_regimen_idempotency.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/011_nutrient_expansion.sql
```

`004`, `005`, `006`, `007`, `008`, `009`, `010`, and `011` are additive and rerunnable. `002` is forward-only and
irreversible because of the legacy reset. The disposable integration database
is selected explicitly; do not treat skipped PostgreSQL tests as a pass:

```bash
export DATABASE_URL_TEST='postgres://localhost:5432/nutrition_mcp_test'
DATABASE_URL_TEST="$DATABASE_URL_TEST" bun test --reporter dots
DATABASE_URL_TEST="$DATABASE_URL_TEST" bun run typecheck
bun run format:check
 git diff --check
```

For a focused docs/runtime check, use `bun test src/food-tracking-docs.test.ts`.
For changed documentation, use `bunx prettier --check README.md docs/food-tracking-agent-driven.md src/food-tracking-docs.test.ts`.
Known repository-wide formatting or typecheck drift in unrelated pre-existing
files must be reported as such; this document does not claim to fix it.
