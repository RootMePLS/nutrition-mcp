# Slice 5 brief: supplement regimens and append-only intake state

## Authority

This brief is subordinate to, and may not narrow:

- `.hermes/plans/2026-08-06-nutrition-reuse-supplements-brief.md`, B3, B4, B5, B7, B10, C2, C3
- `.hermes/plans/2026-08-06-nutrition-reuse-supplements-plan.md`, Slice 5 at lines 206–216, relevant MCP contracts and AC matrix rows B3–B5/B7/B10

Slices 1–4 are accepted. Baseline main: `0fbe369dbf8551d5ad4f847727d5efdc35c0460b`.

## Scope lock

Implement the public, user-scoped supplement regimen and intake-history vertical path.

1. **Regimens**
    - Explicit mutation to create optional product-version-bound regimens: product/version, positive dose servings, validated declarative schedule, timezone, start/end, active state, auditable creation/change metadata.
    - Read/list and explicit active/deactive operation as defined by the governing plan.
    - Never create an intake, meal event, scheduler job, notification, or reminder merely from a regimen/read.

2. **Append-only intake facts and 3-state visible projection**
    - Explicit authorized intake mutation takes direct product ID/version or safe alias resolution, positive servings, time, state action and idempotency.
    - Append immutable facts only. Preserve actor/time/reason/supersession enough to audit corrections.
    - Internal `done | missed | cleared`; public state exactly `undefined | done | missed`, where absent/cleared projects undefined. No automatic marking.
    - Snapshots retain product-version nutrient facts scaled by servings, preserving unknown-vs-zero truth. No later label revision changes historical intake facts.

3. **Alias and ownership safety**
    - Direct product ID supported; product/version must be caller-owned, active, and valid.
    - Unique alias can be resolved read-only; ambiguity must produce candidates/error and zero writes. Cross-user/deleted/inactive product or regimen must fail closed without existence leakage.
    - Read-only resolve/list/status paths make no domain writes.

4. **Public MCP surface**
    - Implement the Slice 5 tool family called for by governing plan: `create_supplement_regimen`, `list_supplement_regimens`, `set_supplement_regimen_active`, `resolve_supplement_product`, `log_supplement_intake`, `get_supplement_intakes`, `get_supplement_regimen_status`.
    - Every public tool gets strict runtime schema, typed output schema/structured content, analytics, truthful annotations and stable errors.
    - Keep data-only, no medical/dosage advice.

5. **Hard Slice 5 boundary**
    - Do NOT create sports-nutrition snack meal events or intake meal links. That is Slice 6 only.
    - Do NOT implement reporting/flags, cron, reminders, provider calls, MyFitnessPal, OCR/STT/vision, Telegram, medical advice, or UI.
    - No migration edits to `001`–`009`. Existing `006/007` tables should be used; if a real gap is proven, append a forward-only migration and upgrade coverage, never rewrite shipped migrations.

6. **Executable acceptance**
    - Real PostgreSQL plus real `McpServer` + `Client` + `InMemoryTransport`; add to DB gate per convention.
    - Cover schedule validation, user scope, product/version immutability, state projection/transitions, alias ambiguity, direct ID path, retries/conflicts/concurrency, rollback after snapshot work, NULL vs numeric zero, deleted/inactive handling, and proof that noncaloric/sports intakes in this slice produce no meal root.
    - Preserve legacy food/alcohol paths.

## Environment safety

Destructive DB gates must use the documented disposable `nutrition_mcp_test`, with explicit matching `DATABASE_URL_TEST` and `DATABASE_URL`. `.env` runtime `nutrition_mcp` is not disposable.

## Planner output

Planner-fable: inspect current live products/supplements schema/services/tests/MCP wiring and Slice 1–4 conventions. Write a detailed repo-grounded RED→GREEN plan only to:

`/Users/fishhead/.workspace/projects/nutrition-mcp/.hermes/plans/2026-08-06-slice-5-regimens-intakes-plan.md`

Include AC-to-artifact/executable-proof coverage, every exact path, contradictions/defaults, transactional/idempotency and error policies, real DB/MCP adversarial gates, and an explicit no-silent-narrowing check. Do not implement production code.
