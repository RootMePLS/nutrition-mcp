# Brief: fix falling legacy meal tools after event-schema migration

## Repository

- `/Users/fishhead/.workspace/projects/nutrition-mcp`
- Bun + TypeScript MCP server.
- Current branch: `main`, aligned with `origin/main` at planning time.
- Working tree is already dirty with pre-existing changes and many untracked `.hermes/plans/*` files. Do not discard, reset, or overwrite unrelated work.

## Smoke-test evidence

A real MCP SDK client connected to local `http://127.0.0.1:8080/mcp`:

- MCP initialize: PASS
- tools/list: PASS, 48 tools
- 11/19 selected read-only calls passed.
- These tools fail with `relation "meals" does not exist`:
    - `get_meals_today`
    - `get_meals_by_date`
    - `get_meals_by_date_range`
    - `get_nutrition_summary`
    - `get_goal_progress`
    - `get_trends`
    - `get_meal_patterns`
    - `search_meals`
- `search_meals` input schema itself requires `queries: string[]`; with the correct shape it still fails on `meals`.
- Local PostgreSQL `nutrition_mcp` contains `meal_events`, `meal_event_items`, `meal_event_versions`, `meal_event_inputs`, `meal_event_media`, `meal_event_nutrition_results`, `meal_event_canonical_results`, `meal_event_sync_journal`, etc., but no `meals` table.
- `db/migrations/002_food_tracking.sql` explicitly replaces the flat legacy `meals` model and drops it.

## User decision

The old flat meal events are not needed. Fix the falling tools to read the new append-only `meal_events` model. Do not restore the deleted `meals` table and do not create a compatibility legacy table unless the planner proves it is strictly required and documents why.

## Required workflow

Planner-fable must inspect the repository and produce the implementation plan at:
`/Users/fishhead/.workspace/projects/nutrition-mcp/.hermes/plans/2026-08-05-legacy-meal-tools-event-schema-fix-plan.md`

The plan must include:

- exact affected files and all old `meals` query paths;
- mapping from event/version/item/canonical tables to the output contracts of each failing tool;
- whether `log_meal` and mutating legacy tools are also broken and must be migrated in the same bounded slice;
- TDD order and regression tests through a real MCP client/transport;
- migration/test-DB requirements and an explicit `DATABASE_URL_TEST` gate;
- preservation of current append-only semantics, current-version reads, corrections, idempotency, and user scoping;
- acceptance criteria for all affected tools, not merely the 8 observed read failures;
- no Telegram/STT/OCR/provider-worker work. Hermes owns orchestration; this repo owns storage/domain/MCP boundary.

Do not implement code in the planning stage. After the plan is complete, stop and report the plan path and any contradictions requiring Dmitrii's decision.
