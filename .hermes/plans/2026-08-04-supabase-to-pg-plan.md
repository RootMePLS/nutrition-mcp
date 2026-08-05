# Supabase → Local PostgreSQL Migration Plan

## Goal

Swap `@supabase/supabase-js` for `pg` (node-postgres) with direct SQL. Single-user, no auth, local-only. Reuse existing Homebrew PostgreSQL 16 on `localhost:5432`. Run Bun natively.

## Infrastructure

- **PG instance**: Existing Homebrew PostgreSQL 16 on `localhost:5432` — no new container
- **Database**: `CREATE DATABASE nutrition_mcp` (manual, one-time)
- **Connection string**: `DATABASE_URL=postgres://localhost:5432/nutrition_mcp` (Bun connects natively)
- **Docker**: No `docker-compose.yml`. No PG container. Bun runs natively.
- **User model**: Hardcoded `SINGLE_USER_ID` (a UUID, e.g. `00000000-0000-0000-0000-000000000001`). All `user_id` columns become this constant.
- **Auth**: None. `/mcp` has zero middleware. No tokens, no bearer, no OAuth.
- **Rate limiting**: Simplified — per-user sliding window on the hardcoded ID (keeps the single-user safe from runaway loops), but no auth-failure ban map.

---

## File-by-File Change List

### FILES TO DELETE (entirely)

| File                                                                    | Lines           | Reason                                                                                                 |
| ----------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| `src/oauth.ts`                                                          | 453             | Full OAuth 2.0 flow (sessions, Google sign-in, PKCE, token exchange) — no auth needed                  |
| `src/oauth.test.ts`                                                     | ~150            | Tests for oauth.ts                                                                                     |
| `src/middleware.ts`                                                     | 180             | `authenticateBearer`, `rateLimit`, `banRepeatAuthFailures`, `rateLimitAuth` — no auth                  |
| `src/middleware.test.ts`                                                | ~120            | Tests for middleware.ts                                                                                |
| `src/discovery.ts`                                                      | 110             | OAuth discovery endpoints (`.well-known/oauth-*`) — no OAuth                                           |
| `src/discovery.test.ts`                                                 | ~80             | Tests for discovery.ts                                                                                 |
| `supabase/` (entire directory)                                          | ~600 (12 files) | Supabase-specific migrations with RLS, auth FK refs, grants/roles — replaced by consolidated migration |
| `supabase/migrations/20260417044712_remote_schema.sql`                  | 313             | Supabase remote schema dump                                                                            |
| `supabase/migrations/20260417044800_nutrition_goals.sql`                | 17              | RLS + `auth.users(id)` FK                                                                              |
| `supabase/migrations/20260417050150_hydration.sql`                      | 24              | RLS + `auth.users(id)` FK                                                                              |
| `supabase/migrations/20260417051650_profiles.sql`                       | 15              | RLS + `auth.users(id)` FK                                                                              |
| `supabase/migrations/20260417052713_idempotency_keys.sql`               | 18              | Unique partial indexes (keep in consolidated)                                                          |
| `supabase/migrations/20260620120000_exports_bucket.sql`                 | 6               | Supabase Storage bucket — not needed                                                                   |
| `supabase/migrations/20260624090000_public_landing_stats.sql`           | 28              | Supabase RPC function — rewrite in consolidated                                                        |
| `supabase/migrations/20260626120000_food_cache.sql`                     | 18              | RLS grants — strip RLS in consolidated                                                                 |
| `supabase/migrations/20260702120000_weight_tracking.sql`                | 40              | RLS + `auth.users(id)` FK                                                                              |
| `supabase/migrations/20260717120000_widget_display_setting.sql`         | 7               | Additive ALTER — fold into consolidated                                                                |
| `supabase/migrations/20260726120000_fiber_sugar_alcohol.sql`            | 47              | Additive ALTER — fold into consolidated                                                                |
| `supabase/migrations/20260726130000_restrict_service_role_policies.sql` | 27              | RLS policy scoping — not needed                                                                        |

### FILES TO CREATE

| File                                   | Est. Lines     | Complexity | Description                                                                                                                                                                      |
| -------------------------------------- | -------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/db.ts`                            | ~800           | HIGH       | Drop-in replacement for `supabase.ts`. Uses `pg` Pool. All ~50 functions rewritten as raw SQL. Exports same TypeScript interfaces (Meal, Profile, etc.) and function signatures. |
| `db/migrations/001_initial_schema.sql` | ~180           | MEDIUM     | Consolidated schema: all tables, indices, constraints, the `public_landing_stats` function. No RLS, no Supabase grants/roles, no `auth.users` FK — `user_id` is just `text`.     |
| `src/export.ts`                        | ~120 (rewrite) | MEDIUM     | Replace Supabase Storage with `Bun.write` + Hono download route. Keep `buildMealsCsv` unchanged.                                                                                 |

### FILES TO MODIFY

| File                             | Est. Changes                | Complexity | What Changes                                                                                                                                                                                                                                                                    |
| -------------------------------- | --------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                   | ~50 lines changed (was 300) | MEDIUM     | Remove OAuth router import/mount, remove auth middleware imports, `/mcp` becomes bare `handleMcp`. Remove `getLandingStats` import → import from `db.ts`. Add export download route. Remove `startExportCleanup` → replace with FS-based sweep. Keep all static/landing routes. |
| `src/mcp.ts`                     | ~5 lines changed (was 3945) | LOW        | `c.get("userId")` → `SINGLE_USER_ID` (imported from `db.ts`). Change import paths from `"./supabase.js"` → `"./db.js"`.                                                                                                                                                         |
| `src/foods.ts`                   | ~20 lines changed (was 344) | LOW        | `getSupabase()` → `getPool()`. Two calls changed: `getCachedFood` (`.from("food_cache").select()`) → `pool.query("SELECT ...")` and `putCachedFood` (`.from("food_cache").upsert()`) → `pool.query("INSERT ... ON CONFLICT")`                                                   |
| `src/analytics.ts`               | ~10 lines changed (was 170) | LOW        | `getSupabase().from("tool_analytics").insert()` → `pool.query("INSERT INTO tool_analytics ...")`. Update error category string from `"supabase_error"` → `"database_error"`.                                                                                                    |
| `src/rate-limit.ts`              | ~40 lines deleted           | LOW        | Remove `authBuckets`, `authFailures`, `checkAuthRateLimit`, `noteAuthFailure`, `clearAuthFailures`, `getBanState`, and related sweep logic. Keep `buckets` + `checkRateLimit` + sliding window. Keep `_resetBuckets` for tests.                                                 |
| `src/rate-limit.test.ts`         | ~30 lines deleted           | LOW        | Remove tests for deleted auth functions.                                                                                                                                                                                                                                        |
| `src/supabase.test.ts`           | renamed to `src/db.test.ts` | HIGH       | All test setup changes: mock Supabase client → mock pg Pool. Test assertions change from supabase-js query builder → raw SQL parameter checks.                                                                                                                                  |
| `src/mcp.test.ts`                | ~10 lines changed           | LOW        | Mock imports change from supabase.ts → db.ts. Add `SINGLE_USER_ID` constant in test context.                                                                                                                                                                                    |
| `src/export.test.ts`             | ~20 lines changed           | LOW        | Remove supabase storage mocks → mock Bun.file/Bun.write. Keep CSV column alignment tests unchanged.                                                                                                                                                                             |
| `src/foods.test.ts`              | ~10 lines changed           | LOW        | Mock `getSupabase` → mock `getPool`.                                                                                                                                                                                                                                            |
| `package.json`                   | ~3 lines changed            | LOW        | `"@supabase/supabase-js": "^2.110.5"` → `"pg": "^8.13.0"`. Add `"@types/pg": "^8.11.0"` to devDependencies. Remove `"generate-oauth-creds"` script.                                                                                                                             |
| `.env.example`                   | ~10 lines net removal       | LOW        | Replace all Supabase/Google env vars with single `DATABASE_URL=postgres://localhost:5432/nutrition_mcp`. Keep `PORT` and `OFF_USER_AGENT`.                                                                                                                                      |
| `public/login.html`              | DELETED                     | LOW        | No auth, no login page needed.                                                                                                                                                                                                                                                  |
| `public/alternatives/index.html` | Update link                 | LOW        | Links to sign-up / login removed from landing pages if present.                                                                                                                                                                                                                 |
| `src/alt-pages.test.ts`          | ~5 lines removed            | LOW        | Remove login-page test assertions.                                                                                                                                                                                                                                              |

### FILES UNCHANGED (20+)

`insights.ts`, `insights.test.ts`, `search.ts`, `search.test.ts`, `import.ts`, `import.test.ts`, `normalize.ts`, `tz.ts`, `tz.test.ts`, `units.ts`, `units.test.ts`, `alcohol.ts`, `alcohol.test.ts`, `csv.ts`, `csv.test.ts`, `chunk.ts`, `chunk.test.ts`, `net.ts`, `net.test.ts`, `url.ts`, `widgets.ts`, `widgets.test.ts`, `public/widgets/`, `public/styles.css`, `public/*.html` (except login.html), `public/map-data.json`, `public/og.png`, `public/favicon.ico`, `scripts/`, `server.json`, `tsconfig.json`

---

## Complexity per Component

| Component                       | Complexity  | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/supabase.ts` → `src/db.ts` | **HIGH**    | 1282 lines, ~50 functions, each using supabase-js query builder → raw SQL. Every function must preserve: (1) exact return types/interfaces, (2) idempotency key logic, (3) error handling (`23505` unique violation → dedup race resolution), (4) timezone-aware date range queries, (5) `fetchAllPages` pagination, (6) `searchMeals` token-search pattern. The `deleteAllUserData` function shrinks dramatically (removes auth token tables + Supabase auth.admin call). The `deriveIdempotencyKey` + `mealIdempotencyKey` helpers move as-is. |
| Consolidated migration          | **MEDIUM**  | Merge 12 files into 1. Must keep: all tables with correct column types, all CHECK constraints, all performance indices, the `public_landing_stats` function (rewritten without `security definer`), idempotency partial unique indices. Must drop: RLS policies, `auth.users(id)` foreign keys, Supabase role grants. `user_id` columns change from `uuid references auth.users(id)` → `text not null`.                                                                                                                                          |
| `src/export.ts` rewrite         | **MEDIUM**  | Replace Supabase Storage upload + signed URL generation with: (1) `Bun.write` to a local directory, (2) a Hono route serving the file, (3) a filesystem-based cleanup sweep (stat → unlink if older than TTL). The `buildMealsCsv` function stays identical.                                                                                                                                                                                                                                                                                     |
| `src/index.ts`                  | **MEDIUM**  | Strip 3 imports, remove OAuth router mount, remove auth middleware chain from `/mcp`, add export download route, wire `getLandingStats` to use `db.ts` pool directly (still cached). The diff is ~50 lines across a 300-line file — moderate because it's surgical, not a rewrite.                                                                                                                                                                                                                                                               |
| `src/foods.ts`                  | **LOW**     | Two functions (`getCachedFood`, `putCachedFood`) each do one supabase-js call. Replace with `pool.query(SQL, params)`. The cache logic, TTL checks, and `normalizeOFFProduct` are untouched.                                                                                                                                                                                                                                                                                                                                                     |
| `src/analytics.ts`              | **LOW**     | One insert in `persistAnalytics`. Replace `.from("tool_analytics").insert()` with parameterized INSERT. Error categorization string `"supabase_error"` → `"database_error"`.                                                                                                                                                                                                                                                                                                                                                                     |
| `src/mcp.ts`                    | **LOW**     | 1 line changes: `c.get("userId")` → `SINGLE_USER_ID`. Import paths from `"./supabase.js"` → `"./db.js"`. All 39 tool registrations, SERVER_INSTRUCTIONS, widget logic — unchanged.                                                                                                                                                                                                                                                                                                                                                               |
| `src/rate-limit.ts`             | **LOW**     | Delete ~60 lines of auth-specific code. Keep the sliding-window `checkRateLimit` + `buckets` Map. Trivial surgery.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Test files                      | **MEDIUM**  | `supabase.test.ts` → `db.test.ts` needs the most work (~all mock setup changes). Other test files need minimal import path + mock adjustments.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `package.json`                  | **TRIVIAL** | Swap 1 dependency, add 1 devDependency, remove 1 script.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

---

## Implementation Order (6 Phases)

### Phase 1: Schema Migration (no code changes)

1. Ensure Homebrew PG 16 is running: `brew services list | grep postgresql`
2. `createdb nutrition_mcp` (or `psql -c "CREATE DATABASE nutrition_mcp"`)
3. Write `db/migrations/001_initial_schema.sql` — consolidated schema with:
    - Tables: `meals`, `profiles`, `nutrition_goals`, `water_log`, `weight_log`, `tool_analytics`, `food_cache`
    - **Dropped tables**: `oauth_tokens`, `refresh_tokens`, `auth_codes`, `registered_clients`
    - All `user_id` columns → `text not null`
    - No RLS, no `auth.users` FK, no Supabase grants
    - All CHECK constraints preserved
    - All performance indices preserved
    - Partial unique indices for idempotency keys preserved
    - `public_landing_stats()` rewritten as a plain SQL function (no `security definer`)
4. Run migration: `psql nutrition_mcp < db/migrations/001_initial_schema.sql`
5. Verify: `psql nutrition_mcp -c "\dt"` shows expected tables

### Phase 2: Core DB Layer (`src/db.ts`)

1. Create `src/db.ts` with:
    - `import { Pool } from "pg"`
    - `const SINGLE_USER_ID = "00000000-0000-0000-0000-000000000001"`
    - `const pool = new Pool({ connectionString: process.env.DATABASE_URL })`
    - Export all 50+ functions with identical signatures to current `supabase.ts`
    - Each function: raw SQL with parameterized queries
    - Preserve: `deriveIdempotencyKey`, `mealIdempotencyKey`, `fetchAllPages`
    - `deleteAllUserData`: remove auth-related cleanup, keep data tables
    - **REMOVED functions**: `signUpUser`, `signInUser`, `signInWithGoogleIdToken`, `storeToken`, `getUserIdByToken`, `storeAuthCode`, `consumeAuthCode`, `storeRefreshToken`, `consumeRefreshToken`, `registerClient`
    - `getLandingStats`: rewrite to call `pool.query("SELECT * FROM public_landing_stats()")` → parse JSON result
2. **PITFALL**: supabase-js auto-casts types; `pg` returns strings for numeric/timestamptz. Must cast in TypeScript (`Number(row.calories)`, `new Date(row.logged_at)`).
3. **PITFALL**: supabase-js `.maybeSingle()` semantics (returns `data` or null) vs pg `rows[0] ?? null`.
4. **PITFALL**: supabase-js `.range(from, to)` pagination → pg `LIMIT $1 OFFSET $2`.
5. **PITFALL**: `searchMeals` uses chained `.ilike()` on multiple columns — replace with `WHERE column ILIKE $1 AND column ILIKE $2 ...` in parameterized SQL. The merge-in-code logic (flatMap, dedup, sort, slice) stays identical.
6. **PITFALL**: Error code `"23505"` (unique violation) — pg throws this, supabase-js wraps it. Must catch `error.code === "23505"` in try/catch.
7. **PITFALL**: Error code `"PGRST116"` (no rows from `.single()`) — pg just returns empty array. Replace with `if (rows.length === 0)`.

### Phase 3: Rip Out Auth (middleware, OAuth, discovery)

1. Delete files: `src/oauth.ts`, `src/oauth.test.ts`, `src/middleware.ts`, `src/middleware.test.ts`, `src/discovery.ts`, `src/discovery.test.ts`, `public/login.html`
2. Modify `src/rate-limit.ts`: remove auth-related code (authBuckets, authFailures, noteAuthFailure, clearAuthFailures, getBanState, checkAuthRateLimit, BAN_* constants)
3. Modify `src/rate-limit.test.ts`: remove deleted function tests

### Phase 4: Rewire Index & MCP Entry Points

1. Modify `src/index.ts`:
    - Remove: `import { createOAuthRouter }`, `import { authenticateBearer, rateLimit, banRepeatAuthFailures }`, `import { registerDiscoveryRoutes }`
    - Replace: `import { getLandingStats } from "./supabase.js"` → `from "./db.js"`
    - Remove: `registerDiscoveryRoutes(app)`, `app.route("/", createOAuthRouter())`
    - Change `/mcp` route: `app.all("/mcp", banRepeatAuthFailures, authenticateBearer, rateLimit, handleMcp)` → `app.all("/mcp", handleMcp)`
    - Remove `startExportCleanup()` → replace with FS-based export cleanup
    - Add export download route: `app.get("/exports/:userId/meals.csv", ...)`
2. Modify `src/mcp.ts`:
    - Add `import { SINGLE_USER_ID } from "./db.js"`
    - Change `const userId = c.get("userId") as string` → `const userId = SINGLE_USER_ID`
    - Change all supabase imports → db imports
3. **PITFALL**: `c.get("userId")` type comes from middleware's `declare module "hono"` — remove that declaration or it'll type `userId` as `never`.

### Phase 5: Rewrite Export (Storage → Local FS)

1. Rewrite `src/export.ts`:
    - Remove Supabase storage imports
    - `exportMeals`: write CSV to `./exports/${userId}/meals.csv` with `Bun.write`
    - Return local path: `{ count, url: "/exports/${userId}/meals.csv" }`
    - `sweepStaleExports`: iterate `./exports/` directory with `fs.readdir`, stat files, unlink stale ones
    - `startExportCleanup`: same interval pattern
2. Add Hono route in `src/index.ts`: `app.get("/exports/:userId/meals.csv", ...)`
3. **PITFALL**: `Bun.write` writes atomically but the directory must exist — `mkdirSync("./exports", { recursive: true })`.
4. **PITFALL**: `deleteAllUserData` in `db.ts` currently calls `sb.storage.from("exports").remove(...)` — replace with `unlinkSync(`./exports/${userId}/meals.csv`)` (catch ENOENT, not an error).

### Phase 6: Swap Dependencies, Tests, Cleanup

1. Modify `package.json`:
    - Remove: `"@supabase/supabase-js"`
    - Add: `"pg": "^8.13.0"`, `"@types/pg": "^8.11.0"` (devDep)
    - Remove script: `"generate-oauth-creds"`
2. Modify `.env.example`: replace all Supabase/Google vars with just `DATABASE_URL`
3. Run `bun install` to update lockfile
4. Update `src/supabase.test.ts` → `src/db.test.ts`: mock `pg.Pool` instead of Supabase client
5. Update all other test imports from `"./supabase.js"` → `"./db.js"`
6. Run `bun test` — fix any failing tests
7. Delete `supabase/` directory
8. Run `bun run typecheck`
9. Start server: `bun src/index.ts` → verify `/health` returns `ok`, `/mcp` POST works, `/api/stats` works

---

## All Pitfalls (Compiled)

### Schema Pitfalls

1. **`user_id` type change**: Was `uuid references auth.users(id)`, becomes `text`. The app never validates the UUID format — it just stores/compares strings. The `gen_random_uuid()` default on `meals.id` etc. is a PG function, unchanged.
2. **RLS removal is load-bearing**: The service-role key bypassed RLS, but without Supabase there are no roles. ALL RLS statements must be removed or the tables will be inaccessible to the `pg` client.
3. **`public_landing_stats` function**: Currently `security definer` with revoke/grant. Rewrite as plain SQL function (no SECURITY DEFINER, no REVOKE/GRANT). The function must return `json` (not `jsonb`) to match existing `LandingStats` interface parsing.
4. **Partial unique indices syntax is fine**: `CREATE UNIQUE INDEX ... WHERE idempotency_key IS NOT NULL` works in vanilla PG — no change needed.

### DB Layer Pitfalls

5. **Type coercion**: `pg` returns `integer` as `string` by default unless you configure a custom parser or cast in JS. Every numeric column read must be `Number(row.calories)` or use `pg-types`. Timestamps come as `Date` objects by default (good).
6. **Connection pool management**: supabase-js manages a connection pool internally. `pg.Pool` must be explicitly created. On shutdown, call `await pool.end()`. Currently `src/index.ts` has a simple `process.exit(0)` shutdown — add `await pool.end()` before exit.
7. **`pool.query` error handling**: supabase-js provides structured `{ data, error }` tuples. `pg` throws on error. Every function must wrap in try/catch and re-throw with the same error message format (e.g., `throw new Error(\`Failed to get meals: ${(error as Error).message}\`)`).
8. **Unique violation code**: supabase-js surfaces `error.code === "23505"`. `pg` also throws PostgresError with `.code === "23505"` — same constant, but the catch path is a `try/catch` instead of an `if (error)` check. The `insertMeal`/`insertWater`/`insertWeight` race-condition handlers must be rewritten.
9. **`countMeals` semantics**: Currently `select("id", { count: "exact", head: true })`. Equivalent: `SELECT count(*)::int as count FROM meals WHERE user_id = $1`. The `::int` cast is important — `pg` returns `count(*)` as a string `"0"` otherwise.
10. **`existingIdempotencyKeys` with `.in()` on many keys**: `WHERE idempotency_key = ANY($1::text[])` with an array parameter.
11. **`searchMeals` query builder chains**: The function builds multiple queries and runs them in parallel with `Promise.all`. Each `buildQuery` must become a `pool.query(...)` with parameterized `WHERE user_id = $1 AND logged_at >= $2 AND description ILIKE $3 AND description ILIKE $4 ... ORDER BY logged_at DESC LIMIT $5`. The `escapeLikePattern` results get `%` wrap-around in SQL: `'%' || $3 || '%'` or pre-wrap in JS.
12. **`fetchAllPages`**: The current implementation calls a closure `(from, to) => Promise<T[]>`. Just make the closure do `pool.query("SELECT * FROM meals WHERE user_id = $1 ... LIMIT $2 OFFSET $3", [userId, pageSize, from])`.

### Middleware / Auth Removal Pitfalls

13. **Hono context typing**: `middleware.ts` declares `ContextVariableMap` with `userId` and `accessToken`. Removing the file removes the declaration. `mcp.ts` now uses `SINGLE_USER_ID` directly — no context variable needed. The `suppressAccessLog` variable (used in index.ts ban check) is also removed — but since we remove bans too, the access log suppression is no longer needed.
14. **CORS `Authorization` header**: Currently allowed. Removing it is fine — no client sends it. Keep it as a no-op to avoid breaking existing MCP client configs.
15. **Discovery route removal**: `registerDiscoveryRoutes(app)` is called before the OAuth router mount in `index.ts`. Just delete the call site. The routes served static JSON — no ripple effects.

### Export Pitfalls

16. **`exportMeals` return type**: Currently returns `{ count, url?: string }` where `url` is a signed Supabase URL. New version returns `{ count, url: "/exports/${userId}/meals.csv" }` — a relative path the MCP client must resolve against the server base URL. The `export_meals` tool in `mcp.ts` reads `result.url` — must update to prepend base URL.
17. **`deleteAllUserData` export removal**: Currently calls `sb.storage.from("exports").remove(...)`. Replace with `try { unlinkSync(...) } catch { /* ENOENT ok */ }`.
18. **Export cleanup sweep**: Currently uses Supabase storage list API (paginated, with timestamps). Filesystem version: `readdirSync` the `./exports/` directory, `statSync` each file, compare `mtimeMs` to cutoff, `unlinkSync` stale files. No pagination needed — there's at most one file per user.
19. **Concurrent writes to same export file**: Supabase Storage's `upsert: true` is atomic. `Bun.write` is also atomic (writes to temp file, renames on completion). Same behavior.

### Rate Limiter Pitfalls

20. **`rateLimit` middleware**: Currently keyed on `userId` from context. Since we remove auth middleware, `rateLimit` could either: (a) be removed entirely, (b) still run but key on the hardcoded `SINGLE_USER_ID`. Option (b) is safer — a runaway tool call loop from one MCP session would still be throttled. Keep `checkRateLimit` and call it from `handleMcp` directly (or keep a minimal middleware that reads the hardcoded ID).
21. **Auth rate limit removal**: `checkAuthRateLimit` is only used by the OAuth endpoints. Safe to delete along with OAuth.

### Test Pitfalls

22. **`supabase.test.ts` → `db.test.ts`**: Every test currently mocks `getSupabase()` return value with a supabase-js chain (`.from().select().eq().maybeSingle()`). New tests must mock `pool.query()` returning `{ rows: [...] }`. The test for `mealIdempotencyKey` is pure — unchanged.
23. **`mcp.test.ts`**: Tests that call tool handlers need a `userId` in the Hono context. With `SINGLE_USER_ID` hardcoded, the context setup can be simpler — no need to set `c.set("userId", ...)`.
24. **`foods.test.ts`**: Mocks `getSupabase()` for cache operations. Change to mock `getPool()`.
25. **`analytics.test.ts`**: None exists? Confirm. Currently `analytics.ts` has no test file listed. Add basic tests or leave as-is (it's fire-and-forget logging).
26. **`export.test.ts`**: `buildMealsCsv` tests stay. `exportMeals` tests need rewriting for FS path instead of storage mock. `sweepStaleExports` tests need FS mocking.
27. **`alt-pages.test.ts`**: May reference login page — remove those assertions.

### Operational Pitfalls

28. **Homebrew PG 16 must be running**: `brew services start postgresql@16`. The server fails to start if PG is stopped — add a startup health check that tries `pool.query("SELECT 1")` and logs a clear error.
29. **Database must exist**: `createdb nutrition_mcp` is a manual step. Add a startup check: if the DB doesn't exist, log a clear error with the exact command to run.
30. **No auth means no user provisioning**: The `SINGLE_USER_ID` must exist in `profiles` and `nutrition_goals` for the app to work. Bootstrapping: either add an upsert in the startup path, or include INSERT in the migration. Recommend migration-based: `INSERT INTO profiles (user_id) VALUES ('00000000-0000-0000-0000-000000000001') ON CONFLICT DO NOTHING`.
31. **Port already in use**: The existing server might be running on 8080. Killing it is a prerequisite — add to the plan.

---

## Summary Table

| Phase                   | Files Touched                             | Lines Changed                           | Complexity | Risk                                                             |
| ----------------------- | ----------------------------------------- | --------------------------------------- | ---------- | ---------------------------------------------------------------- |
| 1: Schema               | 1 new, 12 deleted                         | ~180 new, ~600 deleted                  | MEDIUM     | LOW — no code changes, just SQL                                  |
| 2: Core DB              | 1 new (`db.ts`), 1 delete (`supabase.ts`) | ~800 new, ~1282 deleted                 | HIGH       | HIGH — every DB function rewritten, must preserve exact behavior |
| 3: Auth Rip-Out         | 7 deleted, 2 modified                     | ~900 deleted, ~40 removed               | LOW        | LOW — pure deletion                                              |
| 4: Rewire Entry         | 2 modified                                | ~60 changed                             | MEDIUM     | MEDIUM — `c.get("userId")` removal needs careful tracing         |
| 5: Export Rewrite       | 1 rewrite, 1 modified                     | ~120 changed                            | MEDIUM     | MEDIUM — new filesystem surface area                             |
| 6: Dependencies & Tests | 5 modified, 1 renamed                     | ~200 changed                            | MEDIUM     | MEDIUM — test mocks are the biggest risk here                    |
| **TOTAL**               | ~20 files                                 | ~1000 new, ~2600 deleted, ~500 modified | —          | —                                                                |
