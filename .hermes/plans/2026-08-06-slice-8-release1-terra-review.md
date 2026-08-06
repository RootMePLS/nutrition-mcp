# Release 1 final independent Terra audit — PASS

- Reviewed commit: `f9e7b05a2c90b784d6579c0a41079adfba8b7c5f` on `main`
- Governing sources: `2026-08-06-nutrition-reuse-supplements-brief.md`; `2026-08-06-nutrition-reuse-supplements-plan.md` sections 6 and 8.
- Audit scope: full Release 1 implementation, not documentation only.
- Disposable database used for all destructive gates: `postgres://localhost:5432/nutrition_mcp_test`, with `DATABASE_URL` exactly equal to `DATABASE_URL_TEST`.

## Independent gate evidence

| Gate | Command | Result |
| --- | --- | --- |
| Unit gate | `DATABASE_URL_TEST=... DATABASE_URL=... bun run test:unit` | PASS — 629 pass, 406 expected DB-gated skips, 0 fail; unit-gate intentionally removes DB env before its run. |
| DB release gate | `DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL=$DATABASE_URL_TEST bun run test:db` | PASS — 344 pass, 0 fail, 0 skip, 344 tests across all 12 destructive suites. The gate itself refuses unequal URLs, resets `public`, applies migrations 001–010 before every suite, and rejects a suite that runs zero tests (`scripts/test-db-gate.ts:6-22,44-71,95-153`). |
| Typecheck | `bun run typecheck` | PASS — `src/ typechecks clean`. |
| Formatting | `bun run format:check` | PASS — `All matched files use Prettier code style!` |
| Alcohol focused regression | `DATABASE_URL_TEST=... DATABASE_URL=... bun test src/alcohol.test.ts` | PASS — 12 pass, 0 fail, including UK unit and NHS formula assertions. |
| Public smoke | matching-URL `bun run scripts/mcp-smoke.ts` | PASS — full 001–010 reset; all inventory, legacy/capture, and caloric supplement snack round-trip checks passed. |
| Diff hygiene | `git diff --check` | PASS — no output. `git status --short` was empty before this audit artifact was written. |
| Migration/direct integrity spot-check | matching-URL `bun test src/db.integration.test.ts --max-concurrency 1` | PASS — 19 pass, 0 fail; includes 001–005 populated upgrade to 006, 007 composite ownership/lineage constraints, 008/009 reconciliation, and 010. |

The smoke requires exact matching URLs and a parsed database name exactly equal to `nutrition_mcp_test` before `DROP SCHEMA` (`scripts/mcp-smoke.ts:39-69`); it passed 66-tool inventory checks and the product -> done sports intake -> label-derived snack provenance -> intake re-read path.

## Acceptance-criteria verdicts

| AC | Verdict | Independent evidence |
| --- | --- | --- |
| A1 | PASS | `src/meal-reuse.ts:179-254` invokes user-scoped, active lexical projection search with a fixed 90-day lower bound; lexical semantics are explicit (`match_mode: "lexical"`). Real-PG and transport cases passed for case-insensitive tokens, OR alternatives, escaping, user isolation, and no-write reads (`src/meal-reuse.integration.test.ts`, 39 pass; `src/mcp-reuse.integration.test.ts`, 21 pass). |
| A2 | PASS | `rankReuseVariations()` ranks frequency descending then newest occurrence and caps candidates at 2 (`src/meal-reuse.ts:112-152`); DTO exposes components, consumed time, canonical nullable values, source event/version/current marker, and provenance (`:59-94,216-237`). DB gate passed exact -90/-91 boundary, uncapped ranking, two-candidate, ready/pending/no-zero, and historical-current cases. `src/mcp.ts:2817-2909` truthfully calls this lexical, not semantic/AI search. |
| A3 | PASS | Public mutation requires explicit enum confirmation and accepts no caller nutrition/provider values (`src/mcp.ts:2942-2988`). Transactional service copies server-read items, provider and canonical rows, remaps canonical source ids, persists lineage/mappings, and re-derives ready state before commit (`src/meal-reuse.ts:664-986`). It never calls a provider (`:1-5`). Transport re-read via `get_calculation_provenance` passed. |
| A4 | PASS | Active owned source lock and indistinguishable foreign/deleted/not-found path (`src/meal-reuse.ts:700-718`); readiness/compatibility fail closed (`:724-737`) with stable codes (`:266-304`; MCP mapping `src/mcp.ts:2922-2939`). DB/transport gates passed absent, foreign, deleted, bad version, compatibility/pending/unavailable/tampered source and zero-write/no-fabricated-zero assertions. |
| A5 | PASS | Real PostgreSQL direct and public transport evidence: reuse DB suite 39/39 and MCP suite 21/21 passed. Assertions cover current/historical selection, scope, exact copies/lineage, retry/conflict, two-pool concurrency, injected pre-commit rollback, hostile fields inert, deletion/malformed/ineligible sources, and provenance re-read. |
| B1 | PASS | Versioned, user-scoped root/version/alias/nutrient/limit schema is in `006_meal_reuse_and_supplements.sql:67-188`; nutrients are non-null with explicit unit, unknown omission documented/enforced (`:152-171`; `src/supplement-types.ts:32-117`). `007` adds same-owner and product/version integrity. Real DB tests passed explicit zero retained versus absent unknown. |
| B2 | PASS | Product create/revise are transactional and revision appends N+1 then advances only root pointer (`src/supplements.ts:673-783,786-898`); public strict schemas and typed readbacks are registered at `src/mcp.ts:6188-6475`. DB/transport gate passed malformed payload rejection, current/historical reads, immutable revision history, cross-user concealment, retries and concurrent first creation. |
| B3 | PASS | Declarative schedule validates IANA timezone/daily-weekly/local-time/weekdays (`src/supplement-types.ts:119-193`). Regimen registrations state no intake/event/scheduler/reminder (`src/mcp.ts:6477-6490`), and DB tests passed product-version pinning, active state, schedule/window validation, idempotency/concurrency/rollback, and zero side-effect creation. |
| B4 | PASS | Append-only action vocabulary is `done|missed|cleared`; projection emits exactly `undefined|done|missed` (`src/supplement-types.ts:196-214`, schema `006:219-245`). Public intake contract exposes raw audit action and projected visible state (`src/mcp.ts:6727-6759,6818-6888`). Real DB/MCP tests passed absent/cleared undefined, done, missed, corrections/audit fields and immutable history. |
| B5 | PASS | Alias normalization is NFKC/trim/whitespace-collapse/lowercase and intentionally does not disambiguate (`src/supplement-types.ts:216-231`). Intake service supports direct id, unique alias, or regimen; ambiguous candidate resolution throws without a write (`src/supplements.ts:1851-1891`). Public transport passed direct-ID path, read-only resolution, ambiguity candidates/error and zero writes. |
| B6 | PASS | `done` sports-nutrition intake snapshots bound-version nutrients, creates the snack in the same transaction, links it bidirectionally, and only maps compatible stored label keys (`src/supplements.ts:2016-2189`). Provenance is one `own` label result, `label-compat-v1`, `supplement_label`; no provider invocation. DB/transport/smoke passed v1-after-revision exact values, explicit zero/absent truth, non-caloric/no-event, non-done/no-event, retry/concurrency convergence, deleted/inactive fail-close, rollback, and public provenance re-read. |
| B7 | PASS | Read-only annotations and no-write assertions cover search/list/resolve/status/summary/flags. Search is read-only (`src/mcp.ts:2817-2828`); product/resolution/status descriptions deny implicit writes (`:6570-6725,6818-6904`). DB/transport gate passed domain-table count invariance for reads and explicit confirmation/mutation boundaries. |
| B8 | PASS | Summary uses a bounded date/timezone read boundary, separates food, supplement and exact key+unit combined totals without unit conversion (`src/supplement-types.ts:511-584`; tool registration in `src/mcp.ts`, `get_supplement_nutrition_summary`). DB and MCP tests passed separate contributions, timezone, correction-aware effective done logic, missing-vs-zero, snack exclusion, scope and no writes. No scheduler/report delivery exists. |
| B9 | PASS | Flags are data-only read results. Gate passed duplicate exposure, explicit bound label-limit totals, active-regimen unmarked occurrences, timezone/window boundaries, ended/inactive exclusions and no writes. Descriptions expressly prohibit advice (`src/mcp.ts:6730-6732` and data-flag registration); docs tests pin no medical/dosage/interaction advice. |
| B10 | PASS | Full matching-URL DB gate passed all listed supplement/migration/transport suites: 104 repository supplement tests and 26 MCP supplement tests within 344 total. This includes migration chain, scope, version/revision immutability, states, alias ambiguity, strict payloads, retry/concurrency/rollback, NULL/zero, non-caloric behavior, deleted product and inactive regimen cases. |
| C1 | PASS | Dynamic docs test builds the live registration inventory through `McpServer`/`InMemoryTransport` and requires a README row for every tool (`src/food-tracking-docs.test.ts:44-67`). Independent static check found 66 registrations, 66 unique names, and no missing README row. README/docs denials truthfully exclude weekly delivery, cron/reminders, OCR/image parsing, external provider calls, MFP writer, medical advice, and automatic marking (`README.md:116-124`; `docs/food-tracking-agent-driven.md:323-332`). |
| C2 | PASS | New release migrations 006–010 are forward migrations, replayed on clean reset by DB gate. Fresh/upgrade proof passed: 006 preserves populated 001–005 food/profile/alcohol facts; 007 integrity constraints; 008/009 create-race forward recovery; 010 additive idempotency index. Note: historical migration 002 intentionally resets the superseded legacy `meals` table (`002_food_tracking.sql:12-47`); that predates Release 1 and its documented migration contract, while the Release-1 migrations themselves are additive/forward-safe. |
| C3 | PASS | No Release-1 alcohol implementation edit identified in the reviewed range. Focused `src/alcohol.test.ts` returned 12 pass/0 fail; full DB/unit gates also passed legacy food paths. Upgrade fixture passed preservation of profile/goals/water/weight and 006 populated-schema safety. |

## Section 8 adversarial-gate verdicts

| Gate | Verdict | Evidence |
| --- | --- | --- |
| 1. Migration chain / upgrade | PASS | Matching-URL DB gate resets/replays 001–010 before every suite; direct migration suite 19/19 passed 001–005 upgrade to 006 and head integrity. |
| 2. User scope | PASS | `007` composite FKs enforce ownership (`db/migrations/007_ownership_lineage_integrity.sql:62-279`); real MCP tests passed u2 non-discovery/non-reuse/non-product/non-regimen/non-intake/non-summary/non-flag leakage. |
| 3. Version truth | PASS | Current/historical reuse and immutable label/intake/regimen pin tests passed; source and label pointers are locked/advanced transactionally. |
| 4. Reuse provenance | PASS | Byte-for-byte source copy, mapping, re-derived readiness and public re-read passed; readiness failures write no target/zero values. |
| 5. Idempotency | PASS | DB unique constraints and identity comparisons cover reuse, create, regimen and intake; identical replays converge and changed identity conflicts. |
| 6. Concurrency | PASS | Separate-pool/transport `Promise.all` tests passed for reuse, first product create and caloric intake; winner graph is singular. |
| 7. Rollback | PASS | Injected deepest-child/pre-commit hooks passed zero-owned-row assertions for reuse, regimen and caloric intake/snack paths. |
| 8. Deleted / inactive | PASS | Deleted sources/products and inactive/ended regimens passed fail-closed, scope-safe paths; active list/search exclusions are tested. |
| 9. Payload hardening | PASS | Zod strict schemas plus service validation passed invalid UUID/date/offset/schedule/enums/negative-or-nonfinite values/aliases/extra canonical-field cases with zero writes. |
| 10. NULL / zero | PASS | Explicit zero survives label, snapshot, snack and summary paths; absent values remain absent/null and no unit conversion/fabrication occurred. |
| 11. Authorization / scope | PASS | Reads are no-write; reuse requires confirmation enum; product/regimen/intake writes only occur on their explicit mutations; static inspection finds no release provider worker, cron, scheduler or new MCP scope outside registrations. |
| 12. Alcohol regression | PASS | Focused 12-test alcohol suite and all higher gates passed; no Release-1 alcohol behavior change. |

## Documentation, inventory, and index truth

- `src/mcp.ts` has 66 `server.registerTool(` registrations. Independent extraction reported 66 unique live names; README contains all 66 (zero missing).
- The smoke independently advertised the required Release-1 names and `advertised=66`, then exercised real product creation, caloric done intake, snack provenance, and intake readback.
- The README and operator docs make the label snack transparent: one `own` result, `supplement_label`, `label-compat-v1`, compatibility true and null bundle fingerprint; they deny an invented three-provider calculation.
- Before adding this artifact, `git ls-files '.hermes/plans/*.md' | wc -l` returned 101 and INDEX reports tracked 101 / covered 100 because INDEX itself is deliberately excluded (`.hermes/plans/INDEX.md:118-134`). Its dynamic Release-1 review pattern owns this exact review filename, so force-adding it increases tracked and covered together to 102/101 with zero unmatched/duplicates under the stated method.

## Findings

No blocking finding. The only non-release caveat is historical migration 002's intentionally documented legacy-meal reset; Release-1 migrations 006–010 meet the governing forward-safe requirement and passed their upgrade/reset tests.

VERDICT: PASS
RELEASE_1_FINAL_TERRA_COMPLETE
