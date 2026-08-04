# Supabase → Local PostgreSQL Migration (Single-User, No Auth, Existing PG)

## Goal
Clone nutrition-mcp (https://github.com/akutishevsky/nutrition-mcp) and swap Supabase for local PostgreSQL. **Single-user, no auth, local-only.** Run on the same machine as Hermes.

## Infrastructure (KEY CHANGE from previous plan)
- ❌ NO separate PostgreSQL container — reuse existing Homebrew PostgreSQL 16 on `localhost:5432`
- ❌ NO docker-compose.yml
- ✅ New database `nutrition_mcp` on the existing PG instance
- ✅ `DATABASE_URL=postgres://localhost:5432/nutrition_mcp`
- ✅ Bun runs natively (or in a minimal Bun-only Docker container — TBD)
- ✅ `CREATE DATABASE nutrition_mcp` done once manually or in migration

## What to REMOVE entirely
- `src/oauth.ts` — OAuth flow not needed
- `src/middleware.ts` — authenticateBearer, rateLimit, banRepeatAuthFailures
- Their test files
- Supabase Auth functions from supabase.ts
- Supabase Storage (export bucket, signed URLs — replace with local FS)
- Tables: `oauth_tokens`, `refresh_tokens`, `auth_codes`, `registered_clients`
- RLS policies from migrations
- `docker-compose.yml` idea — not needed
- Entire `supabase/` directory (old migrations → replaced by consolidated migration)

## What to CHANGE
- `src/supabase.ts` → `src/db.ts`: replace supabase-js with `pg` (node-postgres). ~50 functions become raw SQL. Drop `user_id` from all — hardcoded `SINGLE_USER_ID`. 
- `src/index.ts`: strip OAuth router, auth middleware. `/mcp` → direct `handleMcp`
- `src/export.ts`: storage → local FS (`Bun.write`), serve via Hono route
- `src/discovery.ts`: strip OAuth metadata, simplify or delete
- `src/foods.ts`: 2 supabase queries → pg pool
- `src/analytics.ts`: 1 supabase insert → pg pool
- `src/mcp.ts`: `c.get("userId")` → `SINGLE_USER_ID`
- `src/rate-limit.ts`: remove auth-specific maps
- `package.json`, `.env.example`: dep swaps, single env var

## What STAYS unchanged (20+ files)
`insights.ts`, `search.ts`, `import.ts`, `normalize.ts`, `tz.ts`, `units.ts`, `alcohol.ts`, `csv.ts`, `chunk.ts`, `discovery.ts`, `net.ts`, `url.ts`, `widgets/`, `public/`, `scripts/`

## Migrations
12 SQL files → 1 consolidated `db/migrations/001_initial_schema.sql`. Drop RLS, drop auth FK references, drop Supabase grants/roles. Tables keep all performance indices.

## Docker (reconsider)
No separate PG needed. Do we want Bun in a container? If yes: single Bun container, `network_mode: host` to reach localhost PG. If no: Bun runs natively. **Default: no container** — Bun runs directly, connects to `localhost:5432`.

## Deliverable
Output to: `/tmp/nutrition-mcp/.hermes/plans/2026-08-04-supabase-to-pg-plan.md`
Same structure: file-by-file, line estimates, complexity, phase order, pitfalls.
