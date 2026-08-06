# Slice 4 Terra remediation plan: strict ISO-8601 reuse timestamps

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make `reuse_meal_calculation` reject parseable-but-non-ISO `reported_at`/`consumed_at` at BOTH the public MCP boundary and the direct `reuseMealCalculation` service boundary, with real-transport RED→GREEN proof, while preserving every currently-valid ISO form.

**Architecture:** One new pure validator `isStrictIsoTimestamp` in `src/meal-types.ts` (the repo's shared validation-helper home — `resolveConsumedAt` already lives there and both `src/meal-reuse.ts` and `src/mcp.ts` already import from it). It gates by shape (regex) first, then uses `Date.parse` only as a calendar backstop for impossible instants. Both boundaries call the same function — DRY, no drift.

**Tech Stack:** Bun + TypeScript, zod v4 (tool input schema), pg, real `McpServer` + `Client` + `InMemoryTransport` harness (`withReuseTools` in `src/meal-reuse.fixtures.ts`), disposable-PG DB gate (`scripts/test-db-gate.ts`).

---

## Authority and finding recap

- Immutable review: reviewer-terra at `e12ae824cf512317b3a8c937820f34c74627c2b0`, FAIL, one HIGH finding.
- Finding: `validateReuseCommand` (src/meal-reuse.ts:406-411) and the tool inputSchema (src/mcp.ts:2762-2773) validate `reported_at`/`consumed_at` with bare `Date.parse()`, which accepts non-ISO strings such as `"August 6, 2026 12:30 UTC"`. Reproduced through real MCP transport.
- Governing locks unchanged: `.hermes/plans/2026-08-06-slice-4-reuse-mutation-brief.md` §1 (strict runtime validation) and the Slice 4 plan.

## Declared decisions and defaults (escalate only if contradicted)

The remediation brief requires a validator "suitable for the repo's existing timestamp conventions". Live conventions (found in code/tests):

- All persisted/emitted timestamps round-trip through `Date#toISOString()` → `YYYY-MM-DDTHH:MM:SS.sssZ` (src/meal-reuse.ts `tsIso`, src/meal-events.ts:494).
- Slice 4 identity tests lock in acceptance of `Z` vs `+00:00` offset variants and sub-millisecond fractions like `.123456Z` (src/meal-reuse.test.ts:133-157 — timestamptz round-trips keep microseconds).

Therefore the strict contract is declared as:

- **ACCEPT:** `YYYY-MM-DDTHH:MM:SS` + optional `.1`–`.999999999` fractional seconds + a **mandatory explicit UTC designator** (`Z` or `±HH:MM`). Examples: `2026-08-06T13:00:00.000Z`, `2026-08-06T13:00:00Z`, `2026-08-06T10:00:00.123456Z`, `2026-08-06T12:30:00+00:00`, `2026-08-06T15:30:00-05:00`.
- **REJECT:** anything `Date.parse` happens to accept but that is not the above — `"August 6, 2026 12:30 UTC"`, `Date#toString()` forms, date-only `2026-08-06`, zoneless `2026-08-06T13:00:00` (ambiguous instant: engines disagree local-vs-UTC; storage is timestamptz and idempotency identity compares milliseconds, so ambiguity is unsafe), minutes-only `2026-08-06T13:00Z`, space instead of `T`, and shape-valid but impossible instants (`2026-02-30T10:00:00Z`, `2026-08-06T25:00:00Z`, `2026-13-06T10:00:00Z`).
- Stable error message text becomes `"<field> must be a strict ISO 8601 timestamp with an explicit UTC offset"` at both boundaries. No existing test asserts the old message text at the service layer beyond field-name substrings, and transport tests assert only `"Invalid arguments"` — verified, zero churn.

## Tight scope — explicitly NOT touched

- `src/mcp.ts:70-75` `received_at` refine (log-capture tool, prior slice contract).
- `src/calculation-bundles.ts:177-181` `source_timestamp` check (prior slice contract).
- `src/tz.ts` `resolveLoggedAt`, `src/meal-types.ts` `resolveConsumedAt` internals (other callers rely on lenient `Date|string` behavior; the reuse path only reaches it after strict validation).
- `reuseIdentityMatches` millisecond comparison (src/meal-reuse.ts:330) — inputs are pre-validated; comparing already-valid ISO via `Date.parse` stays correct.
- No migrations, no docs, no output-schema, no eligibility/idempotency/lineage changes, no Slice 3 discovery changes.

## No-silent-narrowing check

The fix only narrows the set of accepted _strings_ to exactly the public contract ("valid ISO 8601 timestamp") that both the tool description and the Slice 4 lock already promise. Canonical ISO forms used by every existing happy-path test remain accepted (proven by Task 5 regression tests). Output schema, confirmation policy, error taxonomy, and row semantics are untouched.

## Remediation-item → proof matrix

| Brief item                  | Artifact                                                                                     | Executable proof                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| R1 strict validator         | `isStrictIsoTimestamp` in `src/meal-types.ts`                                                | unit accepts/rejects table in `src/meal-reuse.test.ts` (Task 3)                                      |
| R2 both boundaries          | `src/mcp.ts` zod refine + `src/meal-reuse.ts` `validateReuseCommand`                         | Task 2 direct-service DB test; Task 1 transport test                                                 |
| R3 real-transport RED→GREEN | new adversarial test in `src/mcp-reuse.integration.test.ts`                                  | RED run logged in Task 1 step 3; GREEN in Task 4 step 3; row-count deltas asserted `toEqual(before)` |
| R4 preserve valid behavior  | accept cases (Task 3) + offset-form end-to-end test (Task 5) + all pre-existing reuse suites | `bun run test:unit` + `bun run test:db` green (Task 6)                                               |
| R5 gates + commit + push    | —                                                                                            | Task 6 commands                                                                                      |

---

## Preflight (once)

The DB gate requires a disposable database with `DATABASE_URL_TEST === DATABASE_URL` (scripts/test-db-gate.ts refuses otherwise). The repo's gitignored `.env` already defines the disposable test DSN used by prior slices. For focused suite runs export both vars to that same disposable DSN in your shell. NEVER print, log, or commit the DSN.

Confirm the reproduction strings really are `Date.parse`-parseable under Bun before relying on them:

```bash
cd /Users/fishhead/.workspace/projects/nutrition-mcp
bun -e 'for (const s of ["August 6, 2026 12:30 UTC","2026-08-06T13:00:00","2026-08-06"]) console.log(s, Date.parse(s));'
```

Expected: three numeric (non-NaN) values. If any prints NaN under Bun, drop that string from the reject test cases (the in-test `Date.parse` sanity assertion in Task 2 guards this too) — the Terra finding's `"August 6, 2026 12:30 UTC"` must remain.

Also confirm a clean baseline: `git status --short` shows only untracked `.hermes/plans/*` files.

---

### Task 1: RED — public transport rejects parseable non-ISO timestamps

**Objective:** Add the real-MCP-transport regression test; watch it fail against live code.

**Files:**

- Modify: `src/mcp-reuse.integration.test.ts` (inside the existing `describeDb("reuse_meal_calculation transport adversarial (requires DATABASE_URL_TEST)")` block, after the test at ~line 496 "empty idempotency_key, missing consumed_at, malformed source_event_id...")

**Step 1: Write the failing test**

Add inside that describe (it already has `pool`, `validArgs`, `seedReady`, and imports of `domainTableCounts`/`withReuseTools`):

```ts
test("parseable non-ISO reported_at and consumed_at are rejected through the real transport with zero writes", async () => {
    const sourceId = await seedReady("iso-adv-src", "strict iso oats");
    await withReuseTools(pool, "u1", async ({ call }) => {
        const before = await domainTableCounts(pool);
        const cases: Record<string, unknown>[] = [
            validArgs(sourceId, {
                reported_at: "August 6, 2026 12:30 UTC",
                idempotency_key: "iso-adv-1",
            }),
            validArgs(sourceId, {
                consumed_at: "August 6, 2026 12:30 UTC",
                idempotency_key: "iso-adv-2",
            }),
            validArgs(sourceId, {
                reported_at: "2026-08-06T13:00:00",
                idempotency_key: "iso-adv-3",
            }),
            validArgs(sourceId, {
                consumed_at: "2026-08-06",
                idempotency_key: "iso-adv-4",
            }),
        ];
        for (const args of cases) {
            // Every case is Date.parse-parseable — the exact gap in
            // the Terra finding; strict validation must reject anyway.
            for (const field of ["reported_at", "consumed_at"]) {
                const v = args[field];
                expect(Number.isNaN(Date.parse(v as string))).toBe(false);
            }
            const result = await call("reuse_meal_calculation", args);
            expect(result.isError).toBe(true);
            // Zod boundary rejection, not a repository/domain error.
            expect(result.content[0]!.text).toContain("Invalid arguments");
        }
        expect(await domainTableCounts(pool)).toEqual(before);
    });
});
```

**Step 2: Run it to verify RED**

```bash
DATABASE_URL_TEST="$DISPOSABLE_DSN" DATABASE_URL="$DISPOSABLE_DSN" \
  bun test src/mcp-reuse.integration.test.ts -t "parseable non-ISO"
```

Expected: **FAIL** — the first case currently succeeds (creates a meal event), so `expect(result.isError).toBe(true)` fails and/or the final row-count equality fails. Save the failure line for the commit message evidence. Do NOT commit yet.

### Task 2: RED — direct service boundary rejects parseable non-ISO timestamps

**Objective:** Prove direct (non-MCP) callers fail closed too; watch it fail.

**Files:**

- Modify: `src/meal-reuse.integration.test.ts` (inside `describeDb("reuse_meal_calculation fail-closed eligibility (requires DATABASE_URL_TEST)")`, after the test at ~line 1082 "source_version 0 is rejected by validation before any query"; `seedReadySource`, `catchReuseError`, `reuseCommand`, `domainTableCounts`, `MealEventValidationError` are all already in scope)

**Step 1: Write the failing test**

```ts
test("parseable non-ISO reported_at/consumed_at fail strict validation before any query, zero writes", async () => {
    const sourceId = await seedReadySource(
        "u1",
        "iso-src",
        "strict iso porridge",
    );
    const before = await domainTableCounts(pool);
    const cases = [
        { field: "reported_at", value: "August 6, 2026 12:30 UTC" },
        { field: "consumed_at", value: "August 6, 2026 12:30 UTC" },
        { field: "reported_at", value: "2026-08-06T13:00:00" },
        { field: "consumed_at", value: "2026-08-06" },
    ] as const;
    for (const { field, value } of cases) {
        // Date.parse accepts each of these; strict validation must not.
        expect(Number.isNaN(Date.parse(value))).toBe(false);
        const err = await catchReuseError(
            reuseMealCalculation(
                pool,
                reuseCommand({
                    source_event_id: sourceId,
                    idempotency_key: `iso-${field}-${value.length}`,
                    [field]: value,
                }),
            ),
        );
        expect(err).toBeInstanceOf(MealEventValidationError);
        expect(err.message).toContain(field);
        expect(err.message).toContain("ISO 8601");
    }
    expect(await domainTableCounts(pool)).toEqual(before);
});
```

**Step 2: Run it to verify RED**

```bash
DATABASE_URL_TEST="$DISPOSABLE_DSN" DATABASE_URL="$DISPOSABLE_DSN" \
  bun test src/meal-reuse.integration.test.ts -t "parseable non-ISO"
```

Expected: **FAIL** — `catchReuseError` throws "expected reuseMealCalculation to reject, but it resolved" on the first case (the reuse currently succeeds).

### Task 3: Validator — unit-TDD `isStrictIsoTimestamp`

**Objective:** Create the shared strict validator with its accept/reject table.

**Files:**

- Modify: `src/meal-reuse.test.ts` (append a describe inside the existing `describe("slice 4 pure reuse helpers")` block; add the import)
- Modify: `src/meal-types.ts` (insert after `resolveConsumedAt`, ~line 210)

**Step 1: Write failing unit tests**

Add to the imports at the top of `src/meal-reuse.test.ts`:

```ts
import { isStrictIsoTimestamp } from "./meal-types.js";
```

Append inside `describe("slice 4 pure reuse helpers", ...)`:

```ts
describe("isStrictIsoTimestamp (strict reuse timestamp gate)", () => {
    const accepted = [
        "2026-08-06T13:00:00.000Z", // canonical toISOString form
        "2026-08-06T13:00:00Z", // seconds precision, no fraction
        "2026-08-06T12:30:00+00:00", // offset variant of the same instant
        "2026-08-06T10:00:00.123456Z", // timestamptz microsecond round-trip
        "2026-08-06T15:30:00-05:00", // non-UTC explicit offset
    ];
    for (const value of accepted) {
        test(`accepts ${value}`, () => {
            expect(isStrictIsoTimestamp(value)).toBe(true);
        });
    }

    const rejected = [
        "August 6, 2026 12:30 UTC", // Terra finding: Date.parse-parseable
        "Wed Aug 06 2026 13:00:00 GMT+0000", // Date#toString form
        "2026-08-06", // date only
        "2026-08-06T13:00:00", // no explicit UTC designator
        "2026-08-06T13:00Z", // minutes precision only
        "2026-08-06 13:00:00Z", // space instead of 'T'
        "2026-02-30T10:00:00Z", // impossible calendar date
        "2026-08-06T25:00:00Z", // impossible time
        "2026-13-06T10:00:00Z", // impossible month
        "2026-08-06T13:00:00.Z", // empty fraction
        "",
        "not-a-timestamp",
    ];
    for (const value of rejected) {
        test(`rejects ${JSON.stringify(value)}`, () => {
            expect(isStrictIsoTimestamp(value)).toBe(false);
        });
    }

    test("rejects non-string values", () => {
        expect(isStrictIsoTimestamp(1754485200000)).toBe(false);
        expect(isStrictIsoTimestamp(new Date())).toBe(false);
        expect(isStrictIsoTimestamp(null)).toBe(false);
        expect(isStrictIsoTimestamp(undefined)).toBe(false);
    });
});
```

**Step 2: Run to verify RED**

```bash
bun test src/meal-reuse.test.ts
```

Expected: FAIL — `isStrictIsoTimestamp` is not exported from `./meal-types.js`.

**Step 3: Implement the validator**

In `src/meal-types.ts`, directly after `resolveConsumedAt` (~line 210):

```ts
// ---------------------------------------------------------------------------
// Strict ISO-8601 timestamp gate (Slice 4 remediation).
//
// `Date.parse` accepts many non-ISO formats ("August 6, 2026 12:30 UTC"), so
// public reuse timestamps are gated by shape first: full date, 'T', seconds
// precision, optional fractional seconds, and a MANDATORY explicit UTC
// designator ('Z' or ±HH:MM) — storage is timestamptz and reuse idempotency
// identity compares milliseconds, so ambiguous zoneless instants are unsafe.
// `Date.parse` then runs as a calendar backstop so shape-valid but impossible
// instants (2026-02-30, 25:00) are rejected too.
// ---------------------------------------------------------------------------
const STRICT_ISO_TIMESTAMP_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isStrictIsoTimestamp(value: unknown): value is string {
    if (typeof value !== "string") return false;
    if (!STRICT_ISO_TIMESTAMP_RE.test(value)) return false;
    return !Number.isNaN(Date.parse(value));
}
```

**Step 4: Run to verify GREEN**

```bash
bun test src/meal-reuse.test.ts
```

Expected: PASS (all new accept/reject cases plus the pre-existing pure-helper tests). If `.123456Z` unexpectedly fails under Bun's `Date.parse`, do NOT loosen the regex — special-case is unnecessary: the existing identity test (src/meal-reuse.test.ts:148) already proves Bun parses 6-digit fractions, so investigate before changing anything.

### Task 4: GREEN — wire the direct service boundary

**Objective:** Replace the two `Date.parse` checks in `validateReuseCommand`.

**Files:**

- Modify: `src/meal-reuse.ts:406-411` and its meal-types import block (lines 21-26)

**Step 1: Extend the import**

```ts
import {
    deriveReuseIdempotencyFingerprint,
    isStrictIsoTimestamp,
    NUTRIENT_FIELDS,
    resolveConsumedAt,
    type Nutrients,
} from "./meal-types.js";
```

**Step 2: Replace the checks in `validateReuseCommand`**

Replace:

```ts
if (Number.isNaN(Date.parse(command.reported_at))) {
    issues.push("reported_at must be a valid ISO 8601 timestamp");
}
if (Number.isNaN(Date.parse(command.consumed_at))) {
    issues.push("consumed_at must be a valid ISO 8601 timestamp");
}
```

with:

```ts
if (!isStrictIsoTimestamp(command.reported_at)) {
    issues.push(
        "reported_at must be a strict ISO 8601 timestamp with an explicit UTC offset",
    );
}
if (!isStrictIsoTimestamp(command.consumed_at)) {
    issues.push(
        "consumed_at must be a strict ISO 8601 timestamp with an explicit UTC offset",
    );
}
```

**Step 3: Run the Task 2 test to verify GREEN, plus the whole service suite**

```bash
DATABASE_URL_TEST="$DISPOSABLE_DSN" DATABASE_URL="$DISPOSABLE_DSN" \
  bun test src/meal-reuse.integration.test.ts
```

Expected: PASS including the new "parseable non-ISO" test and ALL pre-existing Slice 3/4 tests (valid `.000Z` fixtures unaffected). The Task 1 transport test still FAILS — expected; the MCP boundary is next.

### Task 5: GREEN — wire the MCP boundary + offset-form preservation proof

**Objective:** Replace the zod refinements and prove valid offset-form ISO still works end-to-end.

**Files:**

- Modify: `src/mcp.ts:42` (import) and `src/mcp.ts:2762-2773` (inputSchema)
- Modify: `src/mcp-reuse.integration.test.ts` (one more test in the adversarial describe)

**Step 1: Extend the meal-types import (src/mcp.ts:42)**

```ts
import {
    isStrictIsoTimestamp,
    NUTRIENT_FIELDS,
    type NutrientField,
} from "./meal-types.js";
```

**Step 2: Replace both refinements in the `reuse_meal_calculation` inputSchema**

```ts
                reported_at: z.string().refine(isStrictIsoTimestamp, {
                    message:
                        "reported_at must be a strict ISO 8601 timestamp with an explicit UTC offset",
                }),
                consumed_at: z.string().refine(isStrictIsoTimestamp, {
                    message:
                        "consumed_at must be a strict ISO 8601 timestamp with an explicit UTC offset",
                }),
```

(Keep every other field and the tool description untouched.)

**Step 3: Add the valid-timestamp preservation test**

In `src/mcp-reuse.integration.test.ts`, same adversarial describe, after the Task 1 test:

```ts
test("offset-form ISO timestamps (+00:00) remain accepted end-to-end", async () => {
    const sourceId = await seedReady("iso-ok-src", "offset iso oats");
    await withReuseTools(pool, "u1", async ({ call }) => {
        const result = await call(
            "reuse_meal_calculation",
            validArgs(sourceId, {
                reported_at: "2026-08-06T13:00:00.000+00:00",
                consumed_at: "2026-08-06T12:30:00+00:00",
                idempotency_key: "iso-ok-key",
            }),
        );
        expect(result.isError).not.toBe(true);
        const payload = result.structuredContent as {
            reported_at: string;
            consumed_at: string;
            provenance_status: string;
        };
        // timestamptz round-trip normalizes to the canonical Z form
        // at exactly the supplied instants — values preserved.
        expect(payload.reported_at).toBe("2026-08-06T13:00:00.000Z");
        expect(payload.consumed_at).toBe("2026-08-06T12:30:00.000Z");
        expect(payload.provenance_status).toBe("ready");
    });
});
```

**Step 4: Run the transport suite to verify GREEN**

```bash
DATABASE_URL_TEST="$DISPOSABLE_DSN" DATABASE_URL="$DISPOSABLE_DSN" \
  bun test src/mcp-reuse.integration.test.ts
```

Expected: PASS — Task 1's RED test now green (zod rejects pre-handler, zero writes), preservation test green, and all pre-existing transport tests (listTools schema, happy path, adversarial, concurrency) still green.

### Task 6: Full gates, diff review, commit, push

**Objective:** Repo-standard acceptance and a single focused commit.

**Step 1: Format + typecheck**

```bash
bun run format          # prettier --write; repo style is 4-space
bun run typecheck
```

Expected: prettier rewrites only the five touched files (or none); typecheck clean.

**Step 2: Full unit gate (no DB env)**

```bash
bun run test:unit
```

Expected: 0 fail; totals line printed; DB suites report themselves skipped inside the unit gate as usual.

**Step 3: Full DB gate against the disposable database**

```bash
DATABASE_URL_TEST="$DISPOSABLE_DSN" DATABASE_URL="$DISPOSABLE_DSN" bun run test:db
```

Expected: every suite in scripts/test-db-gate.ts passes with nonzero test counts (a zero-test suite fails the gate).

**Step 4: Diff review**

```bash
git status --short && git diff | cat
```

Expected changed files — EXACTLY these five, nothing else:

- `src/meal-types.ts` (validator added)
- `src/meal-reuse.ts` (import + two checks)
- `src/mcp.ts` (import + two refinements)
- `src/meal-reuse.test.ts` (unit table)
- `src/meal-reuse.integration.test.ts` (service RED→GREEN test)
- `src/mcp-reuse.integration.test.ts` (transport RED→GREEN + preservation tests)

(That is six paths — three source, three test. If anything else changed, revert it.) `.hermes/plans/*` stay untracked; do not add them in this commit.

**Step 5: Commit and push**

```bash
git add src/meal-types.ts src/meal-reuse.ts src/mcp.ts \
        src/meal-reuse.test.ts src/meal-reuse.integration.test.ts \
        src/mcp-reuse.integration.test.ts
git commit -m "fix: slice 4 — strict ISO-8601 reuse timestamps at MCP and service boundaries

Terra HIGH finding (review at e12ae82): reported_at/consumed_at were
gated by bare Date.parse, accepting non-ISO strings like
'August 6, 2026 12:30 UTC'. Shared isStrictIsoTimestamp now gates shape
(date + T + seconds + explicit Z/±HH:MM offset, optional fraction) with
Date.parse as a calendar backstop, applied in validateReuseCommand and
the reuse_meal_calculation zod inputSchema. RED→GREEN proven through
real McpServer + InMemoryTransport and the direct service path with
unchanged domain row counts; canonical/offset/sub-ms ISO forms remain
accepted."
git push
```

Expected: push succeeds to `main`.

---

## Completion criteria (all must hold)

1. Both new adversarial tests were observed RED before the fix and GREEN after (Tasks 1-2 vs 4-5).
2. `"August 6, 2026 12:30 UTC"` on either field is rejected at the public transport with `Invalid arguments` and zero domain-row delta, and at the direct service with `MealEventValidationError` naming the field.
3. All previously green reuse suites (Slice 3 discovery, Slice 4 happy path/eligibility/idempotency/concurrency/rollback/transport) and the full unit + DB gates pass.
4. Diff touches only the six files listed in Task 6 step 4.
