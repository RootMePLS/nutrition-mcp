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

| Tool                       | Description                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `log_meal`                 | Log a meal with description, type, calories, macros, fiber, total sugar, alcohol, notes — from text or a photo of your plate                     |
| `start_meal_import`        | Open the in-chat CSV importer: pick an export from another app, map its columns, preview, confirm                                                |
| `bulk_import_meals`        | Write up to 50 imported rows per call — each row validated, duplicates skipped so a re-send is safe                                              |
| `lookup_barcode`           | Look up a packaged product's label nutrition by barcode via Open Food Facts (read from a photo or typed)                                         |
| `get_meals_today`          | Get all meals logged today                                                                                                                       |
| `get_meals_by_date`        | Get meals for a specific date (YYYY-MM-DD)                                                                                                       |
| `get_meals_by_date_range`  | Get meals between two dates (inclusive)                                                                                                          |
| `search_meals`             | Search past meals by keyword, grouped into recurring variations (counts, last logged, typical macros)                                            |
| `get_nutrition_summary`    | Daily nutrition totals + goal progress for a date range                                                                                          |
| `update_meal`              | Update any fields of an existing meal                                                                                                            |
| `delete_meal`              | Delete a meal by ID                                                                                                                              |
| `set_nutrition_goals`      | Set daily calorie, macro, fiber and water targets to reach, sugar and alcohol limits to stay under, plus an optional target weight               |
| `get_nutrition_goals`      | Get the current daily targets and limits                                                                                                         |
| `get_goal_progress`        | Get intake vs. targets and limits for a given day (default: today), plus latest weight vs. target                                                |
| `log_water`                | Log a hydration entry in milliliters                                                                                                             |
| `get_water_today`          | Get today's water intake total and entries                                                                                                       |
| `get_water_by_date`        | Get water intake for a specific date                                                                                                             |
| `delete_water`             | Delete a water log entry by ID                                                                                                                   |
| `log_weight`               | Log a body-weight measurement in kg or lb (converted and stored server-side)                                                                     |
| `get_weight_today`         | Get today's weight entries                                                                                                                       |
| `get_weight_by_date`       | Get weight entries for a specific date                                                                                                           |
| `get_weight_by_date_range` | Get weight entries between two dates (inclusive), grouped by day                                                                                 |
| `get_weight_trends`        | Weight trend: latest, overall change, 7/14/30-day moving averages, min/max, and goal progress                                                    |
| `update_weight`            | Update an existing weight entry                                                                                                                  |
| `delete_weight`            | Delete a weight entry by ID                                                                                                                      |
| `set_weight_unit`          | Set the preferred weight unit (`kg` or `lb`; null to clear)                                                                                      |
| `get_weight_unit`          | Get the preferred weight unit                                                                                                                    |
| `get_trends`               | 7/14/30-day averages, std dev, streaks, day-of-week, best/worst day                                                                              |
| `get_meal_patterns`        | Pre-aggregated behavioural patterns (breakfast effect, late dinner, weekend vs weekday, outliers)                                                |
| `export_meals`             | Export all meals as a CSV and return a 60-minute download link                                                                                   |
| `set_timezone`             | Set the user's IANA timezone (e.g. `America/Los_Angeles`)                                                                                        |
| `get_timezone`             | Get the user's configured timezone                                                                                                               |
| `set_widget_display`       | Enable or disable the in-chat visual widgets (dashboards, rings, charts); enabled by default                                                     |
| `get_widget_display`       | Get whether the in-chat visual widgets are enabled                                                                                               |
| `set_alcohol_tracking`     | Turn alcohol tracking on or off (off by default) and choose US standard drinks or UK units; turning it off hides alcohol rather than deleting it |
| `get_alcohol_tracking`     | Get whether alcohol tracking is on and which standard drink it's displayed in                                                                    |
| `delete_account`           | Permanently delete account and all associated data                                                                                               |

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

## Self-hosting

This section describes the current local PostgreSQL/Bun runtime. Older
Supabase, OAuth, and email/password deployment notes are obsolete and must not
be used for this checkout.

### 1. PostgreSQL and migrations

Create the database named by `DATABASE_URL`, then apply the migrations in order:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_initial_schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/002_food_tracking.sql
```

Migration `002_food_tracking.sql` is **destructive**: it deletes the legacy
`meals` rows and drops the legacy `meals` table before creating the append-only
food-tracking schema. Export any data you need before applying it. Migration
`002` is safe to rerun after a complete or interrupted run, but it is not a
backfill and there is no rollback for the legacy meal reset.

### 2. Environment variables

| Variable            | Description                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | PostgreSQL connection string for the runtime database (default example: `postgres://localhost:5432/nutrition_mcp`)          |
| `DATABASE_URL_TEST` | Isolated PostgreSQL database used by integration tests (default example: `postgres://localhost:5432/nutrition_mcp_test`)    |
| `MEDIA_ROOT`        | Local directory for event media bytes (default example: `./data/media`); PostgreSQL stores metadata and keys, not the bytes |
| `OFF_USER_AGENT`    | Open Food Facts User-Agent for barcode lookups, in the form `AppName (email)`                                               |
| `PORT`              | Server port (default: `8080`)                                                                                               |

> **Making it yours:** The public site includes the maintainer's personal bits — Google Analytics, Patreon/GitHub/contact links, and the `nutrition-mcp.com` domain. Run `bun run depersonalize` to strip them all in one pass (analytics + CSP, the Support/Contact sections, social links, and the domain → a `your-domain.com` placeholder). Use `bun run depersonalize --dry` to preview without writing. Afterwards, swap in your own `public/og.png`, `favicon.ico`, and `apple-touch-icon.png`, and replace the domain placeholder with your real domain.

## Agent-driven meal capture

The append-only meal-event path is also exposed as a transport-neutral, durable capture flow for an agent host. Hermes supplies raw message/evidence/media metadata, clarification answers, prepared drafts, and provider result bundles; this server does not receive Telegram updates, download media, run STT/OCR/vision, or call external MCP servers.

Use `start_meal_capture`, `append_meal_capture_message`, `answer_meal_capture`, and `save_meal_capture_draft` for restart-safe multi-turn storage. `confirm_meal_capture` is the explicit authorization gate: only the user's unambiguous add command (including `добавь`) commits one prepared capture to one `meal_event`; MyFitnessPal authorization remains a pending journal row, never a claim of successful sync. `validate_calculation_bundle` accepts and validates Hermes-supplied `nutrition-local`, `own`, and `myfitnesspal` result metadata. Canonical nutrition is recomputed by the existing `consensus-10pct-v1` policy; missing, failed, and unavailable values are not treated as zero.

Migration order for a new or test database is `001_initial_schema.sql`, `002_food_tracking.sql`, then `003_meal_captures.sql`.

```bash
bun install
cp .env.example .env   # set DATABASE_URL and any local overrides
bun run dev             # starts with hot reload on http://localhost:8080
```

Run the actual MCP server with `bun run start` (or `bun run src/index.ts`).
`GET /health` returns `ok`; MCP clients must use `POST /mcp`.

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
| `GET /health`      | Health check                     |
| `POST /mcp`        | Stateless MCP endpoint (no auth) |
| `GET /favicon.ico` | Server icon                      |

The old OAuth discovery, registration, authorize, approve, and token paths are
not part of this runtime.

## Deploy

The project includes a `Dockerfile` for container-based deployment. The
container still requires a reachable PostgreSQL `DATABASE_URL`; it does not
provide Supabase or OAuth services.

1. Push your repo to a hosting provider (e.g. DigitalOcean App Platform)
2. Set the runtime environment variables listed above, including `DATABASE_URL`
3. The app auto-detects the Dockerfile and deploys on port `8080`
4. Point your domain to the deployed URL

## License

[MIT](LICENSE)
