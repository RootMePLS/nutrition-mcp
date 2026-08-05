# S8 handoff — Supabase/OAuth drift removal and repo-truth docs

Date: 2026-08-06
Slice: S8 of `.hermes/plans/2026-08-05-gap-remediation-campaign-plan.md` (lines 553-593)
Coder: coder-kimi
Base HEAD: `3972a5fc9f7a95880e997b89eac174c133ef70f8` (clean tree, == origin/main at start)
Scope honored: S8 only. No S9, no `db/migrations/*`, no `.hermes` historical edits, no behavior/schema/provider/version changes.

## Deleted files (13 tracked)

- `supabase/migrations/20260417044712_remote_schema.sql`
- `supabase/migrations/20260417044800_nutrition_goals.sql`
- `supabase/migrations/20260417050150_hydration.sql`
- `supabase/migrations/20260417051650_profiles.sql`
- `supabase/migrations/20260417052713_idempotency_keys.sql`
- `supabase/migrations/20260620120000_exports_bucket.sql`
- `supabase/migrations/20260624090000_public_landing_stats.sql`
- `supabase/migrations/20260626120000_food_cache.sql`
- `supabase/migrations/20260702120000_weight_tracking.sql`
- `supabase/migrations/20260717120000_widget_display_setting.sql`
- `supabase/migrations/20260726120000_fiber_sugar_alcohol.sql`
- `supabase/migrations/20260726130000_restrict_service_role_policies.sql`
- `docs/google-auth-setup.md`

The now-empty `supabase/` directory is gone (it contained only `migrations/`; git removed both levels on `git rm`). Verified: `ls supabase` -> No such file or directory.

## Renamed file (1, git mv, similarity preserved)

- `src/supabase.test.ts` -> `src/db-helpers.test.ts`

Inspected subject: every import comes from `./db.js` (`mealIdempotencyKey`, `widgetsEnabledFromProfile`, `alcoholTrackingEnabledFromProfile`, `preferredDrinkUnitFromProfile`, `fetchAllPages`, types `MealInput`/`Profile`) plus `rowContentDigest` from `./import.js`. Describe blocks: `mealIdempotencyKey`, `widgetsEnabledFromProfile`, `alcoholTrackingEnabledFromProfile`, `preferredDrinkUnitFromProfile`, `no-profile defaults, together`, `fetchAllPages` — pure DB-helper unit tests, no client anywhere. `db-helpers.test.ts` matches the content. No test body changed; two stale comments rewritten (Supabase-client header; PostgREST/`.range()` issue-#66 reference -> LIMIT/OFFSET wording).

## Modified files (comment/doc truth only, no behavior)

- `CLAUDE.md` — line 7: analytics now "persisted to the `tool_analytics` table in the local PostgreSQL database" (verified `src/analytics.ts:86-91`: `getPool().query(`INSERT INTO tool_analytics ...`)` via `pg`). Bulk-import section: "free of Supabase" -> "free of database access".
- `src/import.ts` — header comment (Supabase/getSupabase seam wording -> src/db.ts pool), `deriveIdempotencyKey in src/supabase.ts` -> `mealIdempotencyKey in src/db.ts` (the real frozen mirror, proven by the `rowContentDigest` parity test in `src/db-helpers.test.ts`), `supabase-js` transaction comment -> per-row independent statements.
- `src/mcp.test.ts` — `actualSupabase` -> `actualDb` (import + 5 usages); removed the dead `getSupabase` mock override + its comment (proof: `git grep getSupabase` had no other hit anywhere in tracked code; `src/analytics.ts` persists via `getPool()`, so the override mocked a function nothing calls — `src/mcp.test.ts` still 115 pass / 0 fail after removal); comments `./supabase.js stubbed` -> `./db.js stubbed`, "free of Supabase" -> "free of database access".
- `src/mcp.ts` — insights comment: "free of Supabase" -> "free of database access" (comment rewrap only).
- `src/foods.ts` — cache comment: "no Supabase config" -> "no database config".
- `src/insights.ts` — module comment: "free of Supabase" -> "free of database access".
- `src/url.ts` — removed stale "Shared by ... the OAuth router (which builds the Google callback URL from it)" claim; no OAuth router exists (`git grep -i oauth src/` had only this comment).
- `scripts/widget-harness.ts` — `import type { MealInput, MealInsertResult } from "../src/supabase.js"` (nonexistent module) -> `"../src/db.js"`; `fakeInsert` now returns the `provenance` field the real `MealInsertResult` requires, built via `writeProvenanceFields({ version: 1, provenance_status: "pending", compatibility: true })` mirroring `insertMeal`'s compatibility-write shape. Dev-only harness; outside the src/-scoped typecheck gate but now type-correct against the real types.
- `.gitignore` — removed obsolete `supabase/.temp/` / `supabase/.branches/` rules + comment.
- `.dockerignore` — removed obsolete `supabase` line.
- `public/index.html` — self-host FAQ (JSON-LD + visible copy): "your own Supabase project" -> "your own PostgreSQL database" (matches README self-hosting section).
- `public/llms.txt` — tech stack "(Bun, Hono, Supabase)" -> "(Bun, Hono, PostgreSQL)".
- `public/privacy.html` — "Where it's stored": "All data is stored in Supabase (PostgreSQL)" (+ supabase.com link) -> "All data is stored in a PostgreSQL database."
- `public/terms.html` — third parties: "Supabase for database, authentication, and export storage" -> "Supabase for authentication, DigitalOcean for hosting and the PostgreSQL database" (export storage bucket no longer exists; exports are CSV via MCP).

## Grep inventory

Before (`git grep -in supabase -- ':!supabase' ':!.hermes' ':!db/migrations'`): **52 hits**.
After (same plus `google-auth`/`oauth` sweep): **6 supabase hits, 20 google-auth/oauth hits**, all deliberate survivors justified below.

### Surviving `supabase` hits — line-by-line justification

1. `README.md:13` — "there is no Supabase, OAuth, email/password, or account-registration step." Negative statement of current truth; this is the plan-sanctioned "older deployments" class.
2. `README.md:123` — "Older Supabase, OAuth, and email/password deployment notes are obsolete and must not be used for this checkout." Deliberate historical warning (plan's GREEN text anticipates exactly this survivor).
3. `README.md:219` — "it does not provide Supabase or OAuth services." Negative statement of current truth.
4. `public/privacy.html:86` — "a securely hashed password via Supabase Auth." Hosted-service registration/auth-flow legal copy; rewriting the account-model sections of the privacy policy is product/legal scope, not S8 repo-truth cleanup (see note below).
5. `public/privacy.html:205` — "Authentication is handled by Supabase Auth." Same hosted auth-flow copy class.
6. `public/terms.html:260` — "Supabase for authentication." Same hosted auth-flow copy class; the database/storage part of this sentence WAS corrected.

### Surviving `google-auth`/`oauth` hits — line-by-line justification

1. `README.md:13`, `README.md:123`, `README.md:219` — same negative/historical statements as above.
2. `README.md:212` — "The old OAuth discovery, registration, authorize, approve, and token paths are not part of this runtime." Negative statement of current truth.
3. `public/index.html:86`, `:94` — JSON-LD FAQ answers describing the hosted service's OAuth sign-in flow for MCP clients. Hosted-product marketing copy.
4. `public/index.html:226` — "Free · Open source · OAuth 2.0" eyebrow. Hosted-product marketing copy.
5. `public/index.html:636` — "Works with any MCP client that supports OAuth 2.0 with PKCE..." install section. Hosted-product install-flow copy.
6. `public/index.html:780`, `:825` — ChatGPT install steps ("choose OAuth", "Your client handles the OAuth login"). Hosted-product install-flow copy.
7. `public/index.html:2772`, `:2781` — visible FAQ copies of the JSON-LD OAuth answers. Hosted-product marketing copy.
8. `public/alternatives/{cronometer, lifesum, lose-it, macrofactor, myfitnesspal, yazio}.html:5xx` — "Works with any MCP client that supports OAuth 2.0 with PKCE..." comparison-page install copy (generated from `scripts/gen-alternatives.ts`).
9. `scripts/gen-alternatives.ts:956` — the template for the six alternatives pages above.
10. `public/privacy.html:149` — "We also keep the OAuth access and refresh tokens..." hosted auth-token retention legal copy.

**Why these survive:** they are the hosted nutrition-mcp.com account/connection-UX copy layer (marketing pages, install instructions, privacy/terms account clauses) — a product/legal rewrite, explicitly not "runtime/docs repo-truth" and outside S8's commit boundary (`chore:` cleanup). Every _database/storage/backend_ claim in tracked files outside `.hermes`/`db/migrations` now says PostgreSQL. The hosted-site auth copy contradicting the no-auth runtime is flagged as a product-level follow-up for the maintainer (S9+ or a dedicated website pass).

## Verification results (all commands actually run)

- `bun test src/db-helpers.test.ts` (renamed suite): **24 pass, 0 fail**.
- `bun test src/mcp.test.ts` (mock change): **115 pass, 0 fail** — proves `getSupabase` mock removal and `actualDb` rename behavior-neutral.
- `bun test src/import.test.ts src/foods.test.ts src/insights.test.ts src/food-tracking-docs.test.ts`: **96 pass, 0 fail**.
- `bun run typecheck`: **src/ typechecks clean**.
- `bun run test:unit`: **498 pass / 156 skip / 0 fail, 654 tests** (unit count unchanged by the rename — same 24 tests under the new filename; skip count = DB-gated suites, unchanged).
- `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db`: **140 pass / 0 fail / 0 skip, 140 tests across 8 DB suites** (db.integration 8, meal-events 41, calculation-bundles.integration 13, meal-captures.integration 20, mcp-food-tracking 20, backup-policy 7, legacy-meal-tools.integration 23, calculation-acceptance.integration 8).
- `bunx prettier --check <changed files>`: **all matched files use Prettier code style** (`.gitignore`/`.dockerignore`/`public/llms.txt` carry no Prettier parser — same as the repo-wide gate).
- `git diff --cached --check`: **clean (silence)**.
- No tracked reference to any deleted file (`google-auth-setup`, `supabase/migrations`, `supabase.js`, `supabase.test`): **zero hits**.
- Renamed describe blocks match `db-helpers.test.ts` subject: confirmed (list above).
- `CLAUDE.md` analytics statement matches `src/analytics.ts:88` `INSERT INTO tool_analytics`: confirmed.
- No migrations under `db/migrations` touched; no behavior, schema, provider, version, or S9 changes.

## Commit

One commit per the S8 boundary: `chore: remove Supabase/OAuth artifacts and fix repo-truth docs` (13 deletions, 1 rename, 12 modified files + this handoff).
