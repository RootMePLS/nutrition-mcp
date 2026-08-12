# Nutrition MCP

A remote MCP server for personal nutrition tracking — log meals with calories, macros, fiber and total sugar, log water and body weight, review nutrition history, and import an existing food diary from another app, all through conversation. Alcohol tracking is opt-in and off by default.

[Help me pay for the servers on Patreon][patreon]

[patreon]: https://patreon.com/akutishevskyi?utm_medium=unknown&utm_source=join_link&utm_campaign=creatorshare_creator&utm_content=copyLink

## Quick Start

The current runtime is a single-user, no-auth Bun server backed by local
PostgreSQL. It exposes the MCP protocol at `POST /mcp`; there is no
Supabase, OAuth, email/password, or account-registration step.

```bash
bun install
cp .env.example .env
# Ensure PostgreSQL is running and DATABASE_URL points at the database to use.
bun run start
```

Then configure an MCP client with `http://localhost:8080/mcp`. The hosted URL
`https://nutrition-mcp.com/mcp` is a deployment-specific endpoint, not a
different authentication flow.

Switching from another tracker? See the [nutrition-app alternatives](https://nutrition-mcp.com/alternatives) — how it compares to [MyFitnessPal](https://nutrition-mcp.com/myfitnesspal-mcp), [Cronometer](https://nutrition-mcp.com/cronometer-mcp), [Lose It!](https://nutrition-mcp.com/lose-it-mcp), [MacroFactor](https://nutrition-mcp.com/macrofactor-mcp), [Yazio](https://nutrition-mcp.com/yazio-mcp), and [Lifesum](https://nutrition-mcp.com/lifesum-mcp). Bring your history with you: say "import my meals" and an importer opens in the chat, where you pick the CSV you exported from your old app, map its columns, and check what will be added before anything is saved. Exports from MyFitnessPal, Cronometer, Lose It! and MacroFactor are recognised automatically; any other CSV works by mapping its columns yourself. In clients that can't show in-chat panels, paste the export instead and the AI imports it for you. If your export has an alcohol column and you want it kept, turn alcohol tracking on before importing — the importer skips that column while tracking is off, and re-importing the same file later won't backfill it.

## Demo

[![Demo](https://img.youtube.com/vi/Y1EHbfimQ70/maxresdefault.jpg)](https://youtube.com/shorts/Y1EHbfimQ70)

Read the story behind it: [How I Replaced MyFitnessPal and Other Apps with a Single MCP Server](https://medium.com/@akutishevsky/how-i-replaced-myfitnesspal-and-other-apps-with-a-single-mcp-server-56ca5ec7d673)

## Tech Stack

- **Bun** — runtime and package manager
- **Hono** — HTTP framework
- **MCP SDK** — Model Context Protocol over Streamable HTTP
- **PostgreSQL** — local database, configured with `DATABASE_URL`
- **No authentication** — this runtime is single-user and exposes `/mcp` directly

## MCP Tools

| Tool                               | Description                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `log_meal`                         | Log a meal with description, type, calories, macros, fiber, total sugar, alcohol, notes — from text or a photo of your plate                                                                                                                                                                                                         |
| `start_meal_import`                | Open the in-chat CSV importer: pick an export from another app, map its columns, preview, confirm                                                                                                                                                                                                                                    |
| `bulk_import_meals`                | Write up to 50 imported rows per call — each row validated, duplicates skipped so a re-send is safe                                                                                                                                                                                                                                  |
| `lookup_barcode`                   | Look up a packaged product's label nutrition by barcode via Open Food Facts (read from a photo or typed)                                                                                                                                                                                                                             |
| `get_meals_today`                  | Get all meals logged today                                                                                                                                                                                                                                                                                                           |
| `get_meals_by_date`                | Get meals for a specific date (YYYY-MM-DD)                                                                                                                                                                                                                                                                                           |
| `get_meals_by_date_range`          | Get meals between two dates (inclusive)                                                                                                                                                                                                                                                                                              |
| `search_meals`                     | Search past meals by keyword (lexical, case-insensitive), grouped into recurring variations; also returns typed 90-day reuse-candidate data (source event/version, components, canonical/provenance status)                                                                                                                          |
| `reuse_meal_calculation`           | Create a new meal event from a confirmed past event/version by copying its stored calculation evidence with a source link — explicit confirmation required; no providers are called                                                                                                                                                  |
| `log_meal_event`                   | Log one eating occurrence as an append-only meal event with ordered items, raw evidence, and optional prepared media metadata and provider nutrient estimates; idempotent; explicit MyFitnessPal authorization records a pending journal intent only, never a sync                                                                   |
| `get_calculation_provenance`       | Read stored provider/canonical calculation evidence for an event (current version by default, immutable history via `version`); status is explicit `ready`/`pending`/`unavailable`/`missing`, no zero is fabricated                                                                                                                  |
| `start_meal_capture`               | Open a durable multi-turn meal capture (restart-safe, idempotent); no Telegram/audio/image parsing happens here                                                                                                                                                                                                                      |
| `append_meal_capture_message`      | Append a raw host message (text/answer/photo/audio metadata) to a durable capture — no media download or interpretation                                                                                                                                                                                                              |
| `answer_meal_capture`              | Record the user's answer to a clarification question on a capture; the server does not generate questions                                                                                                                                                                                                                            |
| `attach_meal_capture_media`        | Attach media bytes (base64, 8 MiB decoded cap, strict MIME allow-list); the server computes SHA-256 and the content-addressed storage key; re-attaching identical bytes is idempotent                                                                                                                                                |
| `save_meal_capture_draft`          | Save the prepared draft (items, inputs, media echo); the draft is not committed to a meal event until explicit confirmation                                                                                                                                                                                                          |
| `get_meal_capture`                 | Read one durable capture: state, messages, answers, media metadata, and draft                                                                                                                                                                                                                                                        |
| `cancel_meal_capture`              | Cancel an editable capture (terminal state)                                                                                                                                                                                                                                                                                          |
| `expire_meal_capture`              | Expire an overdue capture (terminal state)                                                                                                                                                                                                                                                                                           |
| `confirm_meal_capture`             | Explicit authorization gate: commit one prepared capture to one meal event only after an unambiguous add command (including `добавь`); replays are idempotent; MyFitnessPal stays a pending journal intent                                                                                                                           |
| `validate_calculation_bundle`      | Validate a Hermes-prepared provider result bundle (nutrition-local, own, myfitnesspal metadata) without writing anything; no external provider calls                                                                                                                                                                                 |
| `commit_calculation_bundle`        | Commit a validated bundle transactionally; the backend recomputes canonical consensus (`consensus-10pct-v1`) per scope; no external provider calls                                                                                                                                                                                   |
| `commit_calculation_correction`    | Append an immutable correction version from a validated bundle (reason, author, idempotency identity, explicit confirmation); canonical nutrients are recomputed backend-side; explicit external authorization creates only a pending sync intent                                                                                    |
| `get_nutrition_summary`            | Daily nutrition totals + goal progress for a date range                                                                                                                                                                                                                                                                              |
| `get_daily_nutrient_summary`       | MFP-style nutrient dashboard for one local day: per-nutrient total, goal, remaining, percent of goal, explicit completeness (high/partial/low/none) and data-coverage percent — missing micronutrient data is reported as missing, never as zero; micronutrient goals are null until stored                                          |
| `update_meal`                      | Update any fields of an existing meal                                                                                                                                                                                                                                                                                                |
| `delete_meal`                      | Delete a meal by ID                                                                                                                                                                                                                                                                                                                  |
| `set_nutrition_goals`              | Set daily calorie, macro, fiber and water targets to reach, sugar and alcohol limits to stay under, plus an optional target weight                                                                                                                                                                                                   |
| `get_nutrition_goals`              | Get the current daily targets and limits                                                                                                                                                                                                                                                                                             |
| `get_goal_progress`                | Get intake vs. targets and limits for a given day (default: today), plus latest weight vs. target                                                                                                                                                                                                                                    |
| `log_water`                        | Log a hydration entry in milliliters                                                                                                                                                                                                                                                                                                 |
| `get_water_today`                  | Get today's water intake total and entries                                                                                                                                                                                                                                                                                           |
| `get_water_by_date`                | Get water intake for a specific date                                                                                                                                                                                                                                                                                                 |
| `delete_water`                     | Delete a water log entry by ID                                                                                                                                                                                                                                                                                                       |
| `log_weight`                       | Log a body-weight measurement in kg or lb (converted and stored server-side)                                                                                                                                                                                                                                                         |
| `get_weight_today`                 | Get today's weight entries                                                                                                                                                                                                                                                                                                           |
| `get_weight_by_date`               | Get weight entries for a specific date                                                                                                                                                                                                                                                                                               |
| `get_weight_by_date_range`         | Get weight entries between two dates (inclusive), grouped by day                                                                                                                                                                                                                                                                     |
| `get_weight_trends`                | Weight trend: latest, overall change, 7/14/30-day moving averages, min/max, and goal progress                                                                                                                                                                                                                                        |
| `update_weight`                    | Update an existing weight entry                                                                                                                                                                                                                                                                                                      |
| `delete_weight`                    | Delete a weight entry by ID                                                                                                                                                                                                                                                                                                          |
| `set_weight_unit`                  | Set the preferred weight unit (`kg` or `lb`; null to clear)                                                                                                                                                                                                                                                                          |
| `get_weight_unit`                  | Get the preferred weight unit                                                                                                                                                                                                                                                                                                        |
| `get_trends`                       | 7/14/30-day averages, std dev, streaks, day-of-week, best/worst day                                                                                                                                                                                                                                                                  |
| `get_meal_patterns`                | Pre-aggregated behavioural patterns (breakfast effect, late dinner, weekend vs weekday, outliers)                                                                                                                                                                                                                                    |
| `export_meals`                     | Export all meals as a CSV and return a 60-minute download link                                                                                                                                                                                                                                                                       |
| `set_timezone`                     | Set the user's IANA timezone (e.g. `America/Los_Angeles`)                                                                                                                                                                                                                                                                            |
| `get_timezone`                     | Get the user's configured timezone                                                                                                                                                                                                                                                                                                   |
| `set_widget_display`               | Enable or disable the in-chat visual widgets (dashboards, rings, charts); enabled by default                                                                                                                                                                                                                                         |
| `get_widget_display`               | Get whether the in-chat visual widgets are enabled                                                                                                                                                                                                                                                                                   |
| `set_alcohol_tracking`             | Turn alcohol tracking on or off (off by default) and choose US standard drinks or UK units; turning it off hides alcohol rather than deleting it                                                                                                                                                                                     |
| `get_alcohol_tracking`             | Get whether alcohol tracking is on and which standard drink it's displayed in                                                                                                                                                                                                                                                        |
| `delete_account`                   | Permanently delete account and all associated data                                                                                                                                                                                                                                                                                   |
| `create_supplement_product`        | Register a supplement or sports-nutrition product from a verified label: immutable version 1, aliases, serving, every supplied nutrient with unit (explicit zero preserved; unknown omitted, never zero); idempotent per key, conflict on a different label under the same key                                                       |
| `get_supplement_product`           | Read one owned product with its label version detail (current by default, immutable historical via `version`); unknown/deleted/foreign fails closed as not found                                                                                                                                                                     |
| `list_supplement_products`         | List current products with their current label summary, ordered by name; user-scoped, deleted excluded unless requested                                                                                                                                                                                                              |
| `search_supplement_products`       | Read-only case-insensitive search over the current label's display name, short name, and aliases; active products only, never writes                                                                                                                                                                                                 |
| `revise_supplement_product_label`  | Append an immutable label version N+1 and advance the current pointer in one transaction; historical versions, intakes, and regimen pins never change; deleted products cannot be revised                                                                                                                                            |
| `create_supplement_regimen`        | Record supplement intent: product + pinned label version, dose, schedule, window — creates no intake, no meal event, no scheduler job, no reminder                                                                                                                                                                                   |
| `list_supplement_regimens`         | List your supplement regimens (newest first; inactive hidden unless requested)                                                                                                                                                                                                                                                       |
| `set_supplement_regimen_active`    | Explicitly deactivate/reactivate a regimen; repeating the current state is an idempotent no-op                                                                                                                                                                                                                                       |
| `resolve_supplement_product`       | Resolve a direct product id or exact alias/name to candidates — read-only; ambiguity returns candidates and never picks silently                                                                                                                                                                                                     |
| `log_supplement_intake`            | Append an immutable intake fact (direct id, unique alias, or active regimen; servings, time, done/missed/cleared); done facts snapshot the bound label version; a done intake of a caloric sports_nutrition product atomically creates and links one snack meal event from the exact stored label version — no providers are called  |
| `get_supplement_intakes`           | Read append-only intake history with per-fact visible state (exactly undefined/done/missed) and audit metadata                                                                                                                                                                                                                       |
| `get_supplement_regimen_status`    | Derive per-occurrence regimen state over a bounded date window — purely derived; nothing is scheduled or auto-marked                                                                                                                                                                                                                 |
| `get_supplement_nutrition_summary` | Read-only bounded date-range summary in an explicit IANA timezone: food contribution (excluding supplement-linked snack events), correction-aware supplement/sports contribution, and a combined total — grouped by exact nutrient key + unit with no unit conversion; absent stays absent, a stored zero stays 0                    |
| `get_supplement_data_flags`        | Read-only transparent data flags over a bounded window: the same nutrient key + unit recorded from two or more distinct products, recorded daily totals vs a label's own explicitly stored maximum, derived past-due unmarked active-regimen occurrences — data facts only, no medical/dosage advice, nothing scheduled or delivered |

## Release 1 scope boundary

This server stores, validates, and reads back nutrition truth; the agent host
owns everything conversational and external.
It does not deliver or schedule weekly reports (the reporting tools are query
boundaries only), has no OCR or image parsing, and offers
no medical, dosage, or interaction advice — the data flags are transparent
recorded facts. There is no cron, scheduler, or
reminders; nothing marks an intake automatically; reuse and snack linkage copy
stored evidence and never re-run or call external nutrition providers; and it
ships no MyFitnessPal writer (explicit authorization records a pending journal
intent only).

## Food-tracking storage and scope

Food tracking uses an append-only `meal_events` aggregate: each correction creates a
new version and advances the root pointer; historical versions and evidence remain
readable. The legacy meal tables are reset destructively by migration `002` when it
is applied, so take an export before upgrading. Event media bytes live under
`MEDIA_ROOT`; PostgreSQL stores only the generated event/version/content-hash key
and metadata. `DATABASE_URL_TEST` points integration tests at an isolated PostgreSQL
database (the local default is `postgres://localhost:5432/nutrition_mcp_test`).

The sync journal records explicit MyFitnessPal add authorization as **pending** only.
This slice intentionally makes no real MFP calls and ships no automatic backup
scheduler or cloud backup service; backup manifests are a contract for an
operator-run backup, not proof that backups ran.

Food-import calls accept at most 50 rows. Each row is limited to 20,000 kcal,
5,000 g for ordinary macros, and 500 g of alcohol; split larger files into
chunks while keeping all rows for a calendar date together. The importer is
idempotent, but it is not an MFP writer or a cloud backup system.

| URI                          | Description                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `nutrition://weekly-summary` | Rolling 7-day digest (averages vs targets, best/roughest day) for proactive pulls |

## Calculation provenance readback

The public `get_calculation_provenance` tool reads the authenticated user's event version (current by default, or an immutable historical `version`) and returns provider status, source IDs, raw payloads, provenance, nullable nutrients, and backend canonical audit fields. Canonical results are materialized per scope: the backend computes consensus independently for the event scope and each item ordinal, persists one canonical row per scope with scope-local `source_result_ids`, and returns the event row as `canonical` plus per-item rows as `item_canonicals` (also in `commit_calculation_bundle`/`commit_calculation_correction` outputs). `provenance_status` is explicit: `ready`, `pending`, `unavailable`, or `missing`. Legacy `log_meal`, bulk import, and legacy updates remain `pending`/`compatibility`; missing values are JSON `null`, never fabricated zeroes (an explicitly stored zero remains zero). `commit_calculation_bundle` and `commit_calculation_correction` accept Hermes-prepared evidence, recompute consensus server-side, preserve immutable history, enforce user scope/idempotency, and create only pending sync-journal intent when explicitly authorized. Hermes owns provider calls; this server does not run Telegram, STT/OCR/vision, or provider workers.

## Legacy write provenance disclosure

`log_meal`, `update_meal`, and `bulk_import_meals` write through the legacy compatibility path: caller-supplied values are persisted as-is, without a multi-provider calculation bundle. Their structured outputs now say so explicitly. The `log_meal`/`update_meal` payload carries `provenance_status`, `event_version`, `has_calculation_bundle`, and a one-line `provenance_note`; `bulk_import_meals` carries the same four fields per result row, as explicit `null`s for rows that were never written (dry runs, failed validation, rows not attempted) because there is no event whose provenance could be reported. `provenance_status` is `compatibility` when no bundle is committed for the version (with `has_calculation_bundle: false`), `complete` once a committed bundle's evidence readback is `ready`, and `pending` when a bundle exists but its evidence is incomplete. The fields come from the persisted write readback via one shared builder, so an idempotent retry of a meal that later gained a calculation bundle reports `complete`, not a stale `compatibility`.

## Totals presence contract (NULL vs zero)

In every public totals payload (`get_nutrition_summary`, `get_goal_progress`, `get_trends`, and the log/update-meal progress payloads) the four core macros (`calories`, `protein_g`, `carbs_g`, `fat_g`) are nullable: a total is `null` only when no meal in the selection has a calculated value for that nutrient — pending calculations are never coalesced to `0`, while an explicitly stored `0` stays `0`. Each payload also carries the integer counts `meals_total` and `meals_calculated`, where `meals_calculated` is a per-nutrient object `{ calories, protein_g, carbs_g, fat_g }` counting how many meals carry each specific macro — presence differs per nutrient, so a partial sum over a mixed selection is never mistaken for a complete one (e.g. `meals_total: 2` with `meals_calculated: { calories: 2, protein_g: 1, carbs_g: 1, fat_g: 1 }` means protein is based on one meal, not two). Range averages keep the historical every-logged-day denominator but are `null` for any core nutrient no day in the window carries — including an empty range, whose core averages are all `null` with zero counts (water alone keeps its legacy `0` average). Text output renders a null total as `no data yet` (never `0%` or `NaN`), the widgets render `—`/`no data yet` for null and `0` only for a real zero, and the `export_meals` CSV keeps empty cells for missing values.

## Self-hosting

This section describes the current local PostgreSQL/Bun runtime. Older
Supabase, OAuth, and email/password deployment notes are obsolete and must not
be used for this checkout.

### 1. PostgreSQL and migrations

Create the database named by `DATABASE_URL`, then apply the migrations in order:

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

Migration `002_food_tracking.sql` is **destructive**: it deletes the legacy
`meals` rows and drops the legacy `meals` table before creating the append-only
food-tracking schema. Export any data you need before applying it. Migration
`002` is safe to rerun after a complete or interrupted run, but it is not a
backfill and there is no rollback for the legacy meal reset. Migrations `003`
through `011` are additive and safe to rerun: `006` adds the meal-reuse lineage
and supplement/sports-nutrition catalogue substrate (products, regimens, and
append-only intake facts), `007` adds the database-enforced ownership/lineage
integrity constraints on top of it, `008` adds the partial unique index
that serializes concurrent first-time product creates per (user, idempotency
key), and `009` deterministically reconciles any pre-`008` race duplicates
(oldest version-1 row keeps the key, losers release it to NULL with all
product and label data preserved, one append-only audit row per decision)
before creating that same index `IF NOT EXISTS`, and `010` adds a nullable
`idempotency_key` column plus a partial unique index on `supplement_regimens
(user_id, idempotency_key)` so regimen creates serialize per (user, key) at
the database. `011` adds the nullable micronutrient/fat-subtype columns to both
meal-event result tables and must be applied to production BEFORE any code
release that reads or writes those columns. If `008` fails on an older
database with `could not create unique index "uniq_spv_user_create_idem"`,
that database carries pre-`008` duplicates: apply `009` (it reconciles and
creates the index), then re-apply `008`, which succeeds as a no-op. A clean
setup must apply all migrations
through `011`; stopping at `005` leaves the reuse/supplement tables absent.

### 2. Environment variables

| Variable            | Description                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | PostgreSQL connection string for the runtime database (default example: `postgres://localhost:5432/nutrition_mcp`)                                       |
| `DATABASE_URL_TEST` | Isolated PostgreSQL database used by integration tests (default example: `postgres://localhost:5432/nutrition_mcp_test`)                                 |
| `MEDIA_ROOT`        | Local directory for event and capture media bytes (default: `var/media`); PostgreSQL stores metadata and generated content-addressed keys, not the bytes |
| `OFF_USER_AGENT`    | Open Food Facts User-Agent for barcode lookups, in the form `AppName (email)`                                                                            |
| `PORT`              | Server port (default: `8080`)                                                                                                                            |

> **Making it yours:** The public site includes the maintainer's personal bits — Google Analytics, Patreon/GitHub/contact links, and the `nutrition-mcp.com` domain. Run `bun run depersonalize` to strip them all in one pass (analytics + CSP, the Support/Contact sections, social links, and the domain → a `your-domain.com` placeholder). Use `bun run depersonalize --dry` to preview without writing. Afterwards, swap in your own `public/og.png`, `favicon.ico`, and `apple-touch-icon.png`, and replace the domain placeholder with your real domain.

## Agent-driven meal capture

The complete boundary, lifecycle, provenance, migration, rollback, and retry contract is documented in [docs/food-tracking-agent-driven.md](docs/food-tracking-agent-driven.md).

### Capture media byte lifecycle

`attach_meal_capture_media` is the public byte path: the agent sends raw media as base64 (`bytes_base64`) with a `kind` (`photo`/`audio`) and `mime_type`. The server — never the caller — owns identity and verification: it decodes the bytes (8 MiB decoded cap), enforces the MIME allow-list (`image/jpeg`, `image/png`, `image/webp`, `audio/ogg`, `audio/mpeg`, `audio/mp4`), computes SHA-256 server-side (an optional caller `sha256` must match or the call fails), generates the capture-scoped content-addressed storage key `capture/<capture_id>/<kind>-<sha256>`, stages the file under `MEDIA_ROOT`, and only then inserts the `meal_capture_media` row inside a transaction. If the transaction rolls back, the staged file is deleted; re-attaching identical bytes returns the existing media identity (`deduplicated: true`) without duplicating row or file. Attaches are user-scoped and rejected once a capture leaves `receiving`/`ready_to_confirm`. The structured output (`capture_id`, `media_id`, `storage_key`, `sha256`, `byte_size`, `capture_state`, `deduplicated`) is exactly what a draft's `media` entries must echo for `confirm_meal_capture` to accept them. The caller can never set `storage_key` directly, and no STT/OCR/vision runs in this server.

The append-only meal-event path is also exposed as a transport-neutral, durable capture flow for an agent host. Hermes supplies raw message/evidence/media metadata, clarification answers, prepared drafts, and provider result bundles; this server does not receive Telegram updates, download media, run STT/OCR/vision, or call external MCP servers.

Use `start_meal_capture`, `append_meal_capture_message`, `answer_meal_capture`, `attach_meal_capture_media`, and `save_meal_capture_draft` for restart-safe multi-turn storage. `confirm_meal_capture` is the explicit authorization gate: only the user's unambiguous add command (including `добавь`) commits one prepared capture to one `meal_event`; MyFitnessPal authorization remains a pending journal row, never a claim of successful sync. `validate_calculation_bundle` accepts and validates Hermes-supplied `nutrition-local`, `own`, and `myfitnesspal` result metadata. Canonical nutrition is recomputed by the existing `consensus-10pct-v1` policy; missing, failed, and unavailable values are not treated as zero.

All nine capture lifecycle tools — `start_meal_capture`, `append_meal_capture_message`, `answer_meal_capture`, `save_meal_capture_draft`, `get_meal_capture`, `cancel_meal_capture`, `expire_meal_capture`, `confirm_meal_capture`, and `attach_meal_capture_media` — declare an `outputSchema` and return machine-checkable `structuredContent` alongside their human-readable text, so clients can consume typed capture state without parsing the text payload.

Migration order for a new or test database is `001_initial_schema.sql`, `002_food_tracking.sql`, `003_meal_captures.sql`, `004_calculation_bundles.sql`, `005_calculation_corrections.sql`, `006_meal_reuse_and_supplements.sql`, `007_ownership_lineage_integrity.sql`, `008_supplement_create_idempotency.sql`, `009_supplement_create_idem_reconciliation.sql`, `010_supplement_regimen_idempotency.sql`, then `011_nutrient_expansion.sql`.

```bash
bun install
cp .env.example .env   # set DATABASE_URL and any local overrides
bun run dev             # starts with hot reload on http://localhost:8080
```

Run the actual MCP server with `bun run start` (or `bun run src/index.ts`).
`GET /health` returns `ok` — it is pure process liveness (the HTTP stack is
up) and says nothing about the database. `GET /ready` is the database
readiness probe: it runs a real `SELECT 1` through the shared PostgreSQL pool
with a hard 2-second ceiling and returns `200 ok` only on success. On failure
it returns `503` with a JSON body naming a redacted `host:port/database`
target (credentials, query string, and fragment are never exposed), e.g.
`{"error":"database not ready: connection failed (target localhost:5432/nutrition_mcp)"}`.
Troubleshooting a 503: check that PostgreSQL is running and reachable at the
redacted target, that `DATABASE_URL` points at the right host/port/database,
and that the database exists (create it and apply the migrations per above).
MCP clients must use `POST /mcp`.

For the full test suite, point integration tests at a disposable database:

```bash
DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun test
bun run typecheck
bun run format:check
```

## Connect to Claude.ai

1. Start the server locally with `bun run start`.
2. Add a custom connector named **Nutrition Tracker**.
3. Use `http://localhost:8080/mcp` as the MCP URL.
4. Connect; no sign-in or registration is expected.

## API Endpoints

| Endpoint           | Description                      |
| ------------------ | -------------------------------- |
| `GET /health`      | Process liveness check           |
| `GET /ready`       | Database readiness probe         |
| `POST /mcp`        | Stateless MCP endpoint (no auth) |
| `GET /favicon.ico` | Server icon                      |

The old OAuth discovery, registration, authorize, approve, and token paths are
not part of this runtime.

## Run with Docker

One-shot local stack (app + PostgreSQL 16, migrations auto-applied):

    docker compose up -d --build

- `db` — postgres:16-alpine with a named volume and pg_isready healthcheck.
- `migrate` — one-shot job: applies `db/migrations/*.sql` in order with
  `ON_ERROR_STOP=1`. All migrations are forward-only and idempotent, so it is
  safe on every `up`.
- `app` — the MCP server, started only after migrations succeed. Healthy when
  `/ready` proves a real database query works.

The app is published on http://localhost:18080 (container port 8080; host 8080
is typically occupied by the non-Docker dev server). MCP endpoint:
http://localhost:18080/mcp

Check status / logs / teardown:

    docker compose ps
    docker compose logs -f app
    docker compose down        # add -v to also drop the database volume

The container still requires a reachable PostgreSQL `DATABASE_URL` (provided
by the `db` service in compose); it does not provide Supabase or OAuth
services.

### Opt-in: run against the existing host database

By default, `docker compose up` uses its own throwaway `db` container and
volume — your local data is never involved. To run the containerized server
against the EXISTING host PostgreSQL database `nutrition_mcp` on
127.0.0.1:5432 (your real data) instead, use the `hostdb` profile:

    docker compose --profile hostdb up -d --build app-hostdb

- **This targets the live database.** `migrate-hostdb` runs first and only
  re-applies the forward-only, idempotent migrations — a no-op on an
  already-migrated database. Nothing is dropped, created, or volumed.
- **Fail-closed safety guard:** migration 002 is destructive (`DELETE FROM
meals; DROP TABLE meals`, retiring the legacy `meals` table), so
  `migrate-hostdb` refuses to run at all — before executing any migration —
  if the host database still contains the legacy `meals` table. No data can
  be destroyed by the opt-in path; migrate `meals` → `meal_events` outside
  this profile first if that ever applies.
- The app is published on http://localhost:18081 (`:8080` is the non-Docker
  dev server, `:18080` the isolated compose app). MCP endpoint:
  http://localhost:18081/mcp
- Avoid treating this and the non-Docker dev server as two long-running
  writers against the same database at once; the profile is meant for
  verification and opt-in Docker runs, not for doubling the live instance.
- Connection defaults assume Homebrew PostgreSQL trust auth as the local
  user; override the user with `HOSTDB_PGUSER=<name>` in the environment if
  your setup differs (add a password to `DATABASE_URL` manually only if your
  host requires one — none is stored in the compose file).

Note: `docker compose --profile hostdb up -d --build` without a service name
also starts the default isolated stack (profiles add to the default set);
naming `app-hostdb` starts only the host-DB pair. Stop it with:

    docker compose --profile hostdb stop app-hostdb migrate-hostdb
    docker compose --profile hostdb rm -f app-hostdb migrate-hostdb

## CI

Every PR and push to main runs, in order: `format:check`, `typecheck`,
`test:unit`, `test:db` (the full destructive PostgreSQL gate against a
disposable `postgres:16` service database — nothing is skipped), then validates
`docker-compose.yml` and builds the Docker image. There is no auto-deploy; the
runtime server is run locally.

## License

[MIT](LICENSE)
