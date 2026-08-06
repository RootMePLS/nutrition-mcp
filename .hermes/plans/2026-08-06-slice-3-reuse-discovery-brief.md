# Slice 3 brief: reusable-meal discovery, read-only

## Authority

This brief is subordinate to, and may not narrow:

- `.hermes/plans/2026-08-06-nutrition-reuse-supplements-brief.md`, A1, A2, A5, B7, C2, C3
- `.hermes/plans/2026-08-06-nutrition-reuse-supplements-plan.md`, Slice 3 at lines 179–190 and AC matrix rows A1/A2

The implementation must remain strictly read-only. Slice 4 owns `reuse_meal_calculation`; do not pre-build or register that mutation.

## Current repository state

- Repo: `/Users/fishhead/.workspace/projects/nutrition-mcp`
- Branch: `main`
- Baseline HEAD: `5ca7a9e85d3cb6a80b8e10918c8cd3eead8f372f`
- Slice 1 and Slice 2 are accepted. The additive `006` substrate and supplement catalogue exist.
- Local terminal currently has neither `DATABASE_URL_TEST` nor `DATABASE_URL` exported. The plan must identify the repo-supported way to obtain/use the disposable real PostgreSQL test DSN without placing secrets in source or plan output.

## Slice 3 acceptance lock

Deliver an evolved, public, **read-only** `search_meals` path that supports reusable historical-calculation discovery.

1. **Lexical discovery, not semantic search**
    - Case-insensitive relaxed matching against meal components and description.
    - User scoped, active-only, no cross-user existence/data leakage.
    - Be precise in code/docs/tool text: no vector/embedding/semantic-search claim.

2. **90-day recurring variation ranking**
    - Rank each variation by frequency over exactly the last 90 days, then recency tie-break.
    - Do not apply a newest-first input cap before frequency grouping that invalidates ranking.
    - Results expose at most two most recent viable source candidates per variation.

3. **Candidate read contract**
    - Each viable candidate exposes source event ID, source version, ordered original components, consumed time, canonical nutrition/status, and provenance availability/status sufficient for Hermes to explain a future reuse choice.
    - Correctly distinguish current/historical version and only expose eligibility truth actually supported by persisted state.
    - Missing/pending/unavailable data stays explicit; do not fabricate zero nutrients.

4. **Public MCP contract**
    - Evolve `search_meals` with typed `outputSchema` and `structuredContent` while preserving existing compatible human text behavior where practical.
    - `listTools` and transport calls must prove the advertised schema/response, not merely internal helpers.
    - Read operations must produce no writes, no provider calls, no workers, no reuse mutation.

5. **Executable proof**
    - Direct real PostgreSQL integration coverage and public `McpServer` + `Client` + `InMemoryTransport` coverage.
    - Include 90-day boundary, frequency and recency ordering, lexical case/escape behavior, current/historical versions, active/deleted and ready/pending/unavailable candidates, user isolation, candidate cap, structured output, and read-only row-count assertions.
    - Update `scripts/test-db-gate.ts` if required by repo convention.
    - Preserve existing food paths and alcohol behavior. No migrations unless planner proves a minimal additive index is required; if so, use a new forward-only migration rather than editing shipped `006`.

## Explicitly out of scope

- `reuse_meal_calculation` mutation, copied evidence, lineage persistence, confirmation handling, idempotency mutation logic, or any Slice 4 work.
- Product/regimen/intake/sports nutrition work from later slices.
- Providers, OCR/STT/vision, Telegram, MyFitnessPal, cron/reminders, UI polish, medical analysis.

## Workflow and output request

Planner-fable: inspect the actual live source, tests, migrations, and MCP patterns first. Then write a repo-grounded, dependency-ordered TDD implementation plan to:

`/Users/fishhead/.workspace/projects/nutrition-mcp/.hermes/plans/2026-08-06-slice-3-reuse-discovery-plan.md`

The plan must include:

- an AC-to-artifact/executable-proof mapping for every locked item above;
- exact files/functions/tests to change or create;
- explicit RED → GREEN sequence and truthful DB/transport gates;
- identified contradictions/defaults, with recommended resolution;
- a clear declaration of any deviation from the governing Slice 3.

Do not implement production code. Do not modify existing files other than writing the requested plan.
