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

## MyFitnessPal sync journal

An explicit add confirmation authorizes a possible MyFitnessPal write and
creates one durable journal intent with `authorization_source` such as
`explicit_add_intent` and state `pending`. The journal state machine is
`pending → in_flight → succeeded|failed|dead_letter` (with the implemented
transition rules). This repository ships no MyFitnessPal writer: `pending` is
not `synced`, and no external ID or success claim may be invented. Local event
persistence is independent of any later external attempt. A correction uses a
separate correction journal identity and remains pending under the same rule.

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
   intake↔snack links). Schema only: no MCP tools are registered for these
   tables yet.

For a new database:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_initial_schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/002_food_tracking.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/003_meal_captures.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/004_calculation_bundles.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/005_calculation_corrections.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/006_meal_reuse_and_supplements.sql
```

`004`, `005`, and `006` are additive and rerunnable. `002` is forward-only and
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
