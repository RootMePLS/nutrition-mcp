# Slice 4 brief: confirmed meal-reuse mutation

## Authority

This brief is subordinate to, and may not narrow:

- `.hermes/plans/2026-08-06-nutrition-reuse-supplements-brief.md`, A3, A4, A5, B7, C2, C3
- `.hermes/plans/2026-08-06-nutrition-reuse-supplements-plan.md`, Slice 4 at lines 192–204 and AC matrix rows A3/A4/A5

Slice 3 is accepted at `927ac25d3c06ece92c4043c41a8c4cba474d354a`. Its discovery candidates expose only current versions. Slice 4 must implement the explicit confirmed mutation, not alter or broaden Slice 3 discovery.

## Current repository state

- Repo: `/Users/fishhead/.workspace/projects/nutrition-mcp`
- Branch: `main`
- Baseline HEAD: `927ac25d3c06ece92c4043c41a8c4cba474d354a`
- Schema includes additive migrations through `009`; lineage tables were introduced in `006`.
- Existing source roots/versions, provider results, canonical results, provenance reads, transactions, idempotency conventions, and public MCP test harness are live.
- Gitignored `.env` exists. Real destructive DB gates must only run with an explicit disposable `DATABASE_URL_TEST` that equals `DATABASE_URL`; never put a real DSN in committed files or planning output.

## Slice 4 acceptance lock

Implement public `reuse_meal_calculation`, strictly as an explicit-confirmation mutation.

1. **Public mutation contract**
    - Requires precise `source_event_id`, `source_version`, fresh `reported_at` and `consumed_at`, non-empty idempotency key, and explicit confirmation accepted by server policy.
    - Does not accept caller-supplied canonical totals, provider results, fingerprints, or source evidence.
    - Has strict runtime validation, typed output schema/structured content, clear mutation annotations, analytics, and stable public errors.

2. **Eligibility and no-leak boundaries**
    - In one transaction, lock and read the exact requested source event/version.
    - Fail closed for absent, cross-user, deleted, nonexistent version, malformed/incomplete/compatibility/pending/unavailable source, and any current-vs-requested-historical policy breach.
    - Stable public errors must not reveal another user’s data/existence. No target writes on any rejection.
    - Define exact eligibility against real persisted provenance: active source; source version exists and belongs to user; complete/ready, non-compatibility canonical and all required provider evidence. Do not fabricate values.

3. **Reuse persistence and provenance**
    - Create a fresh event root/version with the supplied fresh timestamps and server-generated distinct occurrence identity.
    - Copy only server-read source items, provider evidence, canonical facts, and source identity. No provider invocation or user-submitted nutrition data.
    - Persist immutable lineage in existing reuse source/provider-mapping tables, including precise source event/version/result relationships and source bundle fingerprint.
    - Source data remains unchanged. Target is independently readable via public provenance readback, with copied facts and lineage re-readable.

4. **Atomicity, idempotency, concurrency**
    - Same idempotency key + identical command returns the original target readback.
    - Same key + changed semantic identity conflicts with no extra rows.
    - Separate clients + `Promise.all` same-key attempts result in exactly one fresh root/version/provider/canonical/lineage graph; calls converge or return only the declared conflict, never partial/doubled state.
    - Inject post-child/pre-commit failure and prove zero operation-owned target/lineage rows afterward; source stays intact.

5. **Executable acceptance**
    - Real PostgreSQL integration tests and real `McpServer` + `Client` + `InMemoryTransport` public calls, added to the DB gate per repo convention.
    - Public tests must prove explicit confirmation, source scope/eligibility failures, exact source-copy/current and requested historical behavior, provenance re-read, retry/conflict/concurrency/rollback, no external/provider calls, and domain-row counts.
    - Preserve food paths and alcohol behavior. Do not modify prior migrations. If a schema gap is genuinely discovered, create a new additive forward-only migration and upgrade test. Do not edit shipped `006`–`009`.

## Explicitly out of scope

- Slice 5+ product regimen/intake, sports snack linkage, reports, flags, docs closeout.
- Changing Slice 3 search ranking/output semantics except a narrowly necessary shared read seam proven by tests.
- OCR/STT/vision, Telegram, provider calls/workers, MyFitnessPal, scheduler/reminders, medical advice.

## Workflow and output request

Planner-fable: inspect current live source, migrations, public MCP contracts, commits from Slice 3, and existing real-PG tests. Then write a detailed repo-grounded TDD plan only to:

`/Users/fishhead/.workspace/projects/nutrition-mcp/.hermes/plans/2026-08-06-slice-4-reuse-mutation-plan.md`

The plan must include an AC-to-artifact/executable-proof matrix, exact paths/functions/test targets, declared contradictions/defaults, RED→GREEN order, real DB/transport gates, and explicit verification that it does not silently narrow this lock. Do not implement production code or alter existing files other than the requested plan.
