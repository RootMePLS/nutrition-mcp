# Brief: nutrition reuse and supplements, Release 1

## Authority

This brief records decisions confirmed by Dmitrii in the Telegram design interview on 2026-08-06. It is the governing acceptance source for this release. Do not silently narrow it.

## Repository state observed

- Repository: `/Users/fishhead/.workspace/projects/nutrition-mcp`
- Branch: `main`, clean at `6a96f03b3518267e007825570a87a06ed83fe5dd`.
- Bun + TypeScript + PostgreSQL MCP server.
- Existing meal-event substrate: event roots, immutable versions, items, provider results/canonical consensus/provenance, capture lifecycle, and MCP registration in `src/mcp.ts`.
- Existing public `search_meals` groups prior meal variations by text and exposes typical macros.
- Existing alcohol tracking is an opt-in profile setting. It was enabled live for Dmitrii in UK units; do not regress it.
- No supplement/catalogue/model/MCP tool was found.

## Architecture boundary

Hermes owns chat parsing, user clarification, external provider calls, and explicit authorization. `nutrition-mcp` owns runtime validation, PostgreSQL persistence, immutable history/corrections, searches, idempotency, and MCP read/write interfaces. Do NOT build Telegram ingestion, OCR, image hosting/processing, provider workers, MyFitnessPal synchronization, or a scheduler in this repository.

## Release 1 goal

Create a durable Nutrition MCP substrate for:

1. finding and safely reusing previously confirmed meal calculations; and
2. cataloguing and logging supplements/sports nutrition from user-verified label data.

Release 2 (explicitly out of scope here) updates the Hermes skill/chat interaction, adds UI polish, and adds the weekly Hermes cron report.

## Governing acceptance criteria

### A. Repeated meal discovery and reuse

A1. Extend or evolve the existing meal search so an agent can search a user’s historical meals using relaxed component and description matching, case-insensitive, scoped to the authenticated/configured user, without cross-user leakage.

A2. Search results must rank a recurring variation by frequency in the last 90 days, then expose the two most recent viable alternatives. They must carry enough read-only data to let Hermes explain the original components, consumed time, canonical nutrition/status, source event/version, and provenance availability. Do not promise a semantic/vector search unless it actually exists.

A3. Add a public MCP operation that creates a _new_ meal event from a specific prior event/version only after Hermes supplies explicit confirmation. It must reuse the source event’s persisted canonical/provider evidence as immutable copied/referenced evidence, preserve a source event/version link, use a new consumed/reported timestamp, and be idempotent for retry. It must not call providers or allow caller-supplied canonical totals.

A4. Reuse must fail closed if the source is absent, deleted, belongs to another user, lacks complete/ready provenance, is not the requested current/historical version, or fails a material eligibility rule. Return a stable, actionable validation error, never a fabricated 0-valued result.

A5. Test actual PostgreSQL persistence and the public MCP transport/tool boundary: source linkage, current-version selection, user scope, repeated retries/idempotency, concurrent attempts, rollback, deleted/malformed/ineligible sources, and re-read of the new event/provenance.

### B. Supplements and sports nutrition catalogue

B1. Add a versioned product catalogue within nutrition-mcp PostgreSQL. Each product is user-scoped and has a category sufficient to distinguish ordinary supplement from caloric sports nutrition; display name, short name, aliases, brand/form as needed, serving definition, user-confirmed label/source evidence, and versioned nutrient data. Persist every nutrient actually supplied by the label/source, with units/provenance; unknown is NULL/absent, never zero.

B2. A user can add a product with verified label data, read/list/search products by name/alias, and create a later label revision without mutating historical product or intake facts. Runtime validators must safely reject malformed external MCP payloads.

B3. Model optional active regimens: product/version, dose/servings, schedule representation, start/end/active state. Do not create an autonomous scheduler or mark an intake automatically.

B4. Model actual intake facts as immutable/append-only state history such that the user-visible current state supports exactly `undefined`, `done`, and `missed`. An absent mark is `undefined`, not `missed`; the cycle intended by the product is undefined → done → missed → undefined. Preserve who/when/why enough for an auditable correction/supersession story.

B5. Accept a direct intake log for an explicit product/alias and serving count. Alias ambiguity must be explicit and fail/return candidates rather than silently selecting a product. A unique match may be returned for Hermes to confirm. A direct product ID must be supported to remove name ambiguity.

B6. For a caloric sports-nutrition product, a confirmed `done` intake must atomically create or link a snack meal event using the exact stored label-version nutrient data, with bidirectional provenance/linking and retry idempotency. It must NOT re-run the three providers. Non-caloric supplements must not create meal events.

B7. Do not create meal events, schedules, or intake facts until an explicit user-authorized MCP mutation is invoked. A search/suggestion is never a write.

B8. Provide read APIs sufficient for Hermes Release 2 to build a weekly report that separates food nutrients, supplement/sports-nutrition contribution, and total. Release 1 should expose data/aggregates or a clear efficient query boundary, but must not schedule or deliver the report.

B9. Add transparent non-medical data flags only: duplicate nutrient exposure across active products, sum of recorded dose against an explicit label-defined limit where available, and unmarked active-regimen occurrences. No interaction, diagnostic, contraindication, or dosage advice claims.

B10. Exercise actual PostgreSQL and public MCP calls, including migration chain; user scoping; version immutability; label-revision history; all three intake states; ambiguous alias; malformed payloads; retry/concurrency/rollback for caloric linked event creation; NULL vs zero nutrients; no meal event for non-caloric products; and deleted/inactive product/regimen handling.

### C. Documentation and release truth

C1. Update public/operator docs and tool inventory only for capabilities that actually exist. Do not claim weekly reports, image OCR, external provider recalculation, medical analysis, or automatic reminders.
C2. All migrations must be additive/forward-safe for an already-running DB and support a clean local test reset. Do not break existing food-tracking paths.
C3. Maintain existing alcohol tracking behaviour and related tests.

## Required planning output

Write a repo-grounded detailed plan to:
`/Users/fishhead/.workspace/projects/nutrition-mcp/.hermes/plans/2026-08-06-nutrition-reuse-supplements-plan.md`

Before proposing work, inspect exact live paths, migrations, models, existing tests, MCP registration/schema patterns, projections, and docs. Include:

- contradictions/gaps and proposed defaults (do not implement);
- an AC-to-artifact-and-executable-proof matrix covering every criterion above;
- architecture/data model with migration strategy;
- bounded dependency-ordered TDD vertical slices, one coder-kimi dispatch at a time, each with exact paths;
- real PostgreSQL + public MCP transport gates and adversarial cases;
- source-link and cross-user/deleted/version/retry/concurrency/rollback semantics;
- explicit out-of-scope list;
- docs truth-sync paths;
- acceptance criteria and commands grounded in this repo (Bun, actual existing test conventions).

Do not edit production code. This is planning/audit only.
