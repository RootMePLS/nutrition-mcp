# Slice 4 Terra remediation plan 2: strict timestamp RANGE validation

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make the shared `isStrictIsoTimestamp` reject shape-valid but range-invalid timestamps — the `24:00` end-of-day form and out-of-legal-range UTC offsets (`+14:01`, `+15:00`, …) — so both the public MCP boundary and the direct `reuseMealCalculation` service boundary fail closed with zero domain writes, while every currently-legal boundary form stays accepted.

**Architecture:** Production change is confined to ONE function: `isStrictIsoTimestamp` in `src/meal-types.ts` (lines 212-240). Both boundaries (`src/mcp.ts:2766-2773` zod refine, `src/meal-reuse.ts:407-416` `validateReuseCommand`) already call this shared validator with unchanged message text, so hardening the validator fixes both boundaries with zero boundary-file churn — that is the DRY payoff of remediation 1. Tests extend the exact suites/describes the first remediation created.

**Tech Stack:** Bun 1.3.14 + TypeScript, zod (tool inputSchema), pg, real `McpServer` + `Client` + `InMemoryTransport` harness (`withReuseTools`), disposable-PG gates (`scripts/test-db-gate.ts`, `bun run test:unit` / `test:db`).

---

## Authority and finding recap

- Initial immutable Terra review at `e12ae82`: FAIL, HIGH — timestamp validation too permissive.
- First remediation landed at `4063174`; re-review still FAIL, HIGH continuation.
- Remaining gap (verified live against current `main` before writing this plan):
    - `isStrictIsoTimestamp("2026-08-06T24:00:00Z")` → `true` (Bun's `Date.parse` returns `1786060800000`, silently normalizing to `2026-08-07T00:00:00Z`).
    - `isStrictIsoTimestamp("2026-08-06T12:00:00+14:01")` → `true`, `…+15:00` → `true`, `…+23:59` → `true`, `…-15:00` → `true` (ECMAScript parsers accept any offset `±00:00`–`±23:59`).
- Governing Slice 4 strict ISO-8601 runtime validation requirement unchanged (`.hermes/plans/2026-08-06-slice-4-reuse-mutation-brief.md` §1).

## Declared decisions and defaults (escalate only if contradicted)

1. **Legal UTC-offset window is the real-world zone window `[-12:00, +14:00]`** (west max: Baker Island / AoE `-12:00`; east max: Kiritimati `+14:00`). Rule: offset minutes must be `00`–`59`; total offset must satisfy `+` ≤ 840 minutes, `-` ≤ 720 minutes. This rejects both brief candidates (`+14:01` = 841, `+15:00` = 900) and also `-12:01`/`-15:00`. If the reviewer intended a symmetric `±14:00` cap instead, ONLY the west constant changes (720 → 840) plus the two west-side reject rows — the named brief candidates fail under both readings.
2. **`24:00` is rejected outright** (hour component ≤ 23). ISO's end-of-day alias is exactly the parser-normalization hazard the finding names; storage is timestamptz and idempotency identity compares milliseconds, so an input silently becoming the next day is unsafe.
3. **Error message text is intentionally unchanged** (`"<field> must be a strict ISO 8601 timestamp with an explicit UTC offset"`). Range failures are still strict-ISO failures; keeping the text means `src/mcp.ts` and `src/meal-reuse.ts` need NO edits and no existing assertion churns.
4. **Explicit numeric checks even where `Date.parse` already backstops.** Verified under Bun 1.3.14: `Date.parse` rejects `12:99` main-time minutes, `:60` seconds, `+12:99` offsets, and `24:00:00.500Z` — but relying on engine-specific parser behavior is exactly what this finding punishes. The validator checks hour/offset ranges explicitly; `Date.parse` remains only a backstop.
5. **`-00:00` stays accepted** (RFC 3339 unknown-local-offset form; same instant as `Z`; passes the numeric rules). Rejecting it would narrow beyond the mandate. Locked in the unit table so behavior cannot drift silently.
6. **`:60` leap seconds stay rejected** — pre-existing behavior via the `Date.parse` backstop; no change, no new contract.

## Tight scope — explicitly NOT touched

- `src/mcp.ts` and `src/meal-reuse.ts` — zero production edits this round (shared validator does the work).
- `src/mcp.ts:70-75` `received_at` refine, `src/calculation-bundles.ts` `source_timestamp`, `src/tz.ts`, `resolveConsumedAt` internals, `reuseIdentityMatches` — prior-slice contracts, out of scope.
- No migrations, no docs, no output-schema, no Slice 3, no eligibility/idempotency/lineage changes.

## Remediation-item → proof matrix

| Brief item                          | Artifact                                                                                                       | Executable proof                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 range-hardened validator         | `isStrictIsoTimestamp` rewrite in `src/meal-types.ts`                                                          | unit accept/reject rows (Task 1 RED → Task 4 GREEN)                                                                                          |
| R2 RED→GREEN unit + both boundaries | Tasks 1-3 observed RED; Tasks 4-5 GREEN                                                                        | transport test asserts `Date.parse` accepts + tool rejects + zero row delta; direct test asserts `MealEventValidationError` + zero row delta |
| R3 preserve legal boundary forms    | unit accepted rows (+14:00, -12:00, +13:45, -00:00, 23:59:59Z, 00:00:00Z) + transport end-to-end boundary test | Task 1/2 preservation cases green before AND after the fix; full suites in Task 6                                                            |
| R4 disposable DB gates              | Preflight B discovery/safety procedure                                                                         | `bun run test:unit` + `bun run test:db` (Task 6)                                                                                             |
| R5 tight scope                      | diff review                                                                                                    | Task 6 step 4: exactly 4 changed files                                                                                                       |

---

## Preflight A (once): parser-acceptance sanity under Bun

The RED tests assert candidates are `Date.parse`-parseable (the exact normalization gap). Confirm before relying on them:

```bash
cd /Users/fishhead/.workspace/projects/nutrition-mcp
bun -e 'for (const s of ["2026-08-06T24:00:00Z","2026-08-06T24:00:00+00:00","2026-08-06T12:00:00+14:01","2026-08-06T12:00:00+15:00","2026-08-06T12:00:00-15:00","2026-08-06T12:00:00+12:99"]) console.log(JSON.stringify(s), Date.parse(s));'
```

Expected (already verified on this machine, Bun 1.3.14): the first five print numeric values; `+12:99` prints `NaN`. Consequence: the parser-accepted sanity assertion applies to the first five only; `+12:99` is tested as a shape-valid/parser-rejected range case WITHOUT that assertion (unit table only).

Also confirm a clean baseline: `git status --short` shows only untracked `.hermes/plans/*` files, and `git log --oneline -1` shows `4063174`.

## Preflight B (once): discover/set up the disposable DB — SAFETY CRITICAL

Facts found during planning (re-verify, do not assume):

- `.env` sets `DATABASE_URL=postgres://localhost:5432/nutrition_mcp` — that is the NON-disposable dev database. It must NEVER receive test traffic (every DB suite runs `DROP SCHEMA public CASCADE`).
- `.env` has no `DATABASE_URL_TEST`. The project-supported configuration is the README (line ~168, ~213) and `docs/food-tracking-agent-driven.md` (~292): `DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test`.
- `scripts/test-db-gate.ts` refuses unless `DATABASE_URL_TEST` is set AND `DATABASE_URL === DATABASE_URL_TEST` — so both exports below are required.

Procedure (shell-only exports; NEVER edit `.env`, never commit or print a credentialed DSN):

```bash
# 1. Server reachable?
pg_isready -h localhost -p 5432          # expect: accepting connections

# 2. Does the documented disposable DB exist?
psql postgres://localhost:5432/postgres -Atc \
  "SELECT 1 FROM pg_database WHERE datname = 'nutrition_mcp_test';"
# '1' → exists (it did during planning). Empty → create it:
#   createdb -h localhost -p 5432 nutrition_mcp_test

# 3. Pin the DSN for this shell and safety-check it:
export DISPOSABLE_DSN="postgres://localhost:5432/nutrition_mcp_test"
bun -e 'const u = new URL(process.env.DISPOSABLE_DSN!); const db = u.pathname.slice(1);
if (!/_test$/.test(db)) { console.error("REFUSE: dbname must end with _test:", db); process.exit(1); }
if (db === "nutrition_mcp") { console.error("REFUSE: dev database"); process.exit(1); }
console.log("disposable target OK");'
```

Expected: `disposable target OK`. If any check fails, STOP and escalate — do not substitute another database, and specifically do not fall back to the `.env` `DATABASE_URL`.

Every DB-suite command below uses `DATABASE_URL_TEST="$DISPOSABLE_DSN" DATABASE_URL="$DISPOSABLE_DSN"` inline so nothing leaks into the environment beyond the command.

---

### Task 1: RED — unit accept/reject table gains range cases

**Objective:** Extend the existing validator unit table with the range candidates; watch the rejects fail against live code.

**Files:**

- Modify: `src/meal-reuse.test.ts` — inside `describe("isStrictIsoTimestamp (strict reuse timestamp gate)")` (line 250); `accepted` array at lines 251-257, `rejected` array at lines 264-277.

**Step 1: Extend the `accepted` array** (legal boundary forms — preservation lock):

```ts
            "2026-08-06T12:00:00+14:00", // maximum legal east offset (Kiritimati)
            "2026-08-06T12:00:00-12:00", // maximum legal west offset (AoE)
            "2026-08-06T12:00:00+13:45", // Chatham DST — real 45-minute offset
            "2026-08-06T12:00:00-00:00", // RFC 3339 unknown-local-offset; same instant as Z
            "2026-08-06T23:59:59Z", // last plain second of a day
            "2026-08-06T00:00:00Z", // canonical start-of-day (the only midnight form)
```

**Step 2: Extend the `rejected` array** (range candidates):

```ts
            "2026-08-06T24:00:00Z", // ISO end-of-day alias — parser normalizes to next day
            "2026-08-06T24:00:00.000Z", // 24:00 with zero fraction — also parser-accepted
            "2026-08-06T24:00:00+00:00", // 24:00 with offset designator
            "2026-08-06T24:30:00Z", // hour 24 with nonzero minutes
            "2026-08-06T12:00:00+14:01", // Terra finding: beyond +14:00 legal maximum
            "2026-08-06T12:00:00+15:00", // Terra finding: offset hour beyond legal range
            "2026-08-06T12:00:00+23:59", // parser-accepted extreme offset
            "2026-08-06T12:00:00-12:01", // beyond -12:00 legal western maximum
            "2026-08-06T12:00:00-15:00", // far beyond western maximum
            "2026-08-06T12:00:00+12:99", // offset minute out of 00-59 (shape-valid)
```

**Step 3: Run to verify RED**

```bash
bun test src/meal-reuse.test.ts -t "isStrictIsoTimestamp"
```

Expected: **FAIL** — exactly the nine parser-accepted reject rows fail (`24:00:00Z`, `24:00:00.000Z`, `24:00:00+00:00`, `+14:01`, `+15:00`, `+23:59`, `-12:01`, `-15:00` return `true`); `24:30:00Z` and `+12:99` may already pass via the `Date.parse` backstop — fine. All six new accepted rows already pass (they are preservation locks, not RED signals). Do NOT commit yet.

### Task 2: RED — public real-MCP transport rejects range-invalid timestamps with zero writes

**Objective:** Add the transport regression plus the legal-boundary end-to-end preservation test; watch the regression fail.

**Files:**

- Modify: `src/mcp-reuse.integration.test.ts` — inside `describeDb("reuse_meal_calculation transport adversarial (requires DATABASE_URL_TEST)")` (line 426), insert BOTH tests after the "offset-form ISO timestamps (+00:00) remain accepted end-to-end" test (ends line 589, before "forged canonical…" at line 591). `pool`, `seedReady`, `validArgs`, `withReuseTools`, `domainTableCounts` are already in scope.

**Step 1: Write the failing regression test**

```ts
test("parser-accepted 24:00 and out-of-range UTC offsets are rejected through the real transport with zero writes", async () => {
    const sourceId = await seedReady("iso-rng-src", "range iso oats");
    await withReuseTools(pool, "u1", async ({ call }) => {
        const before = await domainTableCounts(pool);
        const cases: Record<string, unknown>[] = [
            validArgs(sourceId, {
                reported_at: "2026-08-06T24:00:00Z",
                idempotency_key: "iso-rng-1",
            }),
            validArgs(sourceId, {
                consumed_at: "2026-08-06T24:00:00+00:00",
                idempotency_key: "iso-rng-2",
            }),
            validArgs(sourceId, {
                reported_at: "2026-08-06T12:00:00+14:01",
                idempotency_key: "iso-rng-3",
            }),
            validArgs(sourceId, {
                consumed_at: "2026-08-06T12:00:00+15:00",
                idempotency_key: "iso-rng-4",
            }),
        ];
        for (const args of cases) {
            // Every candidate is Date.parse-parseable — the parser
            // silently normalizes 24:00 and swallows illegal offsets,
            // which is the exact remaining Terra gap. Strict
            // validation must reject anyway.
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

**Step 2: Write the legal-boundary preservation test** (immediately after; expected to pass at BOTH the RED and GREEN phases — it locks the forms the fix must not break):

```ts
test("maximum legal offsets +14:00 and -12:00 remain accepted end-to-end", async () => {
    const sourceId = await seedReady("iso-max-src", "legal edge oats");
    await withReuseTools(pool, "u1", async ({ call }) => {
        const result = await call(
            "reuse_meal_calculation",
            validArgs(sourceId, {
                reported_at: "2026-08-06T13:00:00.000+14:00",
                consumed_at: "2026-08-06T12:30:00-12:00",
                idempotency_key: "iso-max-key",
            }),
        );
        expect(result.isError).not.toBe(true);
        const payload = result.structuredContent as {
            reported_at: string;
            consumed_at: string;
            provenance_status: string;
        };
        // timestamptz round-trip normalizes to canonical Z at exactly
        // the supplied instants — the legal extremes are preserved.
        expect(payload.reported_at).toBe("2026-08-05T23:00:00.000Z");
        expect(payload.consumed_at).toBe("2026-08-07T00:30:00.000Z");
        expect(payload.provenance_status).toBe("ready");
    });
});
```

**Step 3: Run to verify RED**

```bash
DATABASE_URL_TEST="$DISPOSABLE_DSN" DATABASE_URL="$DISPOSABLE_DSN" \
  bun test src/mcp-reuse.integration.test.ts -t "24:00"
```

Expected: **FAIL** — first case currently sails through zod (`isError` falsy) and/or the final row-count equality fails. Save the failure line for commit evidence.

```bash
DATABASE_URL_TEST="$DISPOSABLE_DSN" DATABASE_URL="$DISPOSABLE_DSN" \
  bun test src/mcp-reuse.integration.test.ts -t "maximum legal offsets"
```

Expected: **PASS** already (preservation baseline).

### Task 3: RED — direct service boundary rejects range-invalid timestamps with zero writes

**Objective:** Prove non-MCP callers fail closed too; watch it fail.

**Files:**

- Modify: `src/meal-reuse.integration.test.ts` — inside `describeDb("reuse_meal_calculation fail-closed eligibility (requires DATABASE_URL_TEST)")` (line 975), insert after the existing "parseable non-ISO … zero writes" test (ends line 1134). `pool`, `seedReadySource`, `catchReuseError`, `reuseCommand`, `reuseMealCalculation`, `domainTableCounts`, `MealEventValidationError` are already in scope.

**Step 1: Write the failing test**

```ts
test("parser-accepted 24:00 and out-of-range UTC offsets fail strict validation before any query, zero writes", async () => {
    const sourceId = await seedReadySource(
        "u1",
        "iso-rng-src",
        "range iso porridge",
    );
    const before = await domainTableCounts(pool);
    const cases = [
        { field: "reported_at", value: "2026-08-06T24:00:00Z" },
        { field: "consumed_at", value: "2026-08-06T24:00:00.000Z" },
        { field: "reported_at", value: "2026-08-06T12:00:00+14:01" },
        { field: "consumed_at", value: "2026-08-06T12:00:00+15:00" },
        { field: "reported_at", value: "2026-08-06T12:00:00-15:00" },
    ] as const;
    for (const [i, { field, value }] of cases.entries()) {
        // Date.parse accepts and silently normalizes each candidate;
        // strict validation must reject the string form regardless.
        expect(Number.isNaN(Date.parse(value))).toBe(false);
        const err = await catchReuseError(
            reuseMealCalculation(
                pool,
                reuseCommand({
                    source_event_id: sourceId,
                    idempotency_key: `iso-rng-${i}`,
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

**Step 2: Run to verify RED**

```bash
DATABASE_URL_TEST="$DISPOSABLE_DSN" DATABASE_URL="$DISPOSABLE_DSN" \
  bun test src/meal-reuse.integration.test.ts -t "out-of-range UTC offsets"
```

Expected: **FAIL** — `catchReuseError` throws "expected reuseMealCalculation to reject, but it resolved" on the first case.

### Task 4: GREEN — harden the shared validator (only production change)

**Objective:** Add explicit hour and offset range enforcement to `isStrictIsoTimestamp`.

**Files:**

- Modify: `src/meal-types.ts:212-240` (the comment block + regex + function; nothing else in the file).

**Step 1: Replace the block**

Replace everything from the `// Strict ISO-8601 timestamp gate` comment block (line 212) through the end of `isStrictIsoTimestamp` (line 240) with:

```ts
// ---------------------------------------------------------------------------
// Strict ISO-8601 timestamp gate (Slice 4 remediation).
//
// `Date.parse` accepts many non-ISO formats ("August 6, 2026 12:30 UTC"), so
// public reuse timestamps are gated by shape first: full date, 'T', seconds
// precision, optional fractional seconds, and a MANDATORY explicit UTC
// designator ('Z' or ±HH:MM) — storage is timestamptz and reuse idempotency
// identity compares milliseconds, so ambiguous zoneless instants are unsafe.
// Numeric ranges are then enforced explicitly because ECMAScript parsers
// silently NORMALIZE two shape-valid classes instead of rejecting them:
//   - the ISO end-of-day alias 24:00:00 (becomes 00:00 of the NEXT day), and
//   - UTC offsets beyond the legal zone window (any ±00:00..±23:59 parses).
// The legal window is the real-world zone range [-12:00, +14:00]
// (Baker Island / AoE west, Kiritimati east). `Date.parse` remains only a
// backstop for the ranges parsers do reject (12:99 minutes, :60 seconds),
// and the date components are round-tripped because JSC normalizes
// impossible calendar dates (2026-02-30 -> 2026-03-02) instead of
// returning NaN.
// ---------------------------------------------------------------------------
const STRICT_ISO_TIMESTAMP_RE =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

const UTC_OFFSET_MAX_EAST_MINUTES = 14 * 60; // +14:00
const UTC_OFFSET_MAX_WEST_MINUTES = 12 * 60; // -12:00

export function isStrictIsoTimestamp(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const match = STRICT_ISO_TIMESTAMP_RE.exec(value);
    if (!match) return false;
    if (Number.isNaN(Date.parse(value))) return false;
    const [, year, month, day, hour, offsetSign, offsetHours, offsetMinutes] =
        match;
    // Reject the parser-normalized end-of-day alias (24:00:00[.0+] parses).
    if (Number(hour) > 23) return false;
    if (offsetSign !== undefined) {
        const minutesPart = Number(offsetMinutes);
        if (minutesPart > 59) return false;
        const totalMinutes = Number(offsetHours) * 60 + minutesPart;
        const maxMinutes =
            offsetSign === "+"
                ? UTC_OFFSET_MAX_EAST_MINUTES
                : UTC_OFFSET_MAX_WEST_MINUTES;
        if (totalMinutes > maxMinutes) return false;
    }
    const roundTrip = new Date(
        Date.UTC(Number(year), Number(month) - 1, Number(day)),
    );
    return (
        roundTrip.getUTCMonth() === Number(month) - 1 &&
        roundTrip.getUTCDate() === Number(day)
    );
}
```

Note the regex change is purely additive capture groups (`(\d{2})` for the hour, `([+-])(\d{2}):(\d{2})` for the offset) — the accepted string LANGUAGE is identical, so no shape behavior changes.

**Step 2: Run the unit suite to verify GREEN**

```bash
bun test src/meal-reuse.test.ts
```

Expected: PASS — all Task 1 rows (new accepts AND new rejects) plus every pre-existing case, including the untouched originals (`.123456Z`, `-05:00`, `+00:00`, the calendar/impossible-instant rejects).

### Task 5: GREEN — both boundaries, no boundary edits

**Objective:** Prove the shared-validator fix closed both boundaries with zero changes to `src/mcp.ts` / `src/meal-reuse.ts`.

**Step 1: Run both integration suites in full**

```bash
DATABASE_URL_TEST="$DISPOSABLE_DSN" DATABASE_URL="$DISPOSABLE_DSN" \
  bun test src/meal-reuse.integration.test.ts
DATABASE_URL_TEST="$DISPOSABLE_DSN" DATABASE_URL="$DISPOSABLE_DSN" \
  bun test src/mcp-reuse.integration.test.ts
```

Expected: PASS — Task 2 and Task 3 RED tests now green (zod rejects pre-handler; `validateReuseCommand` throws `MealEventValidationError` before any query; zero row deltas), the legal-boundary preservation test still green, and every pre-existing Slice 3/4 test (happy path, eligibility, idempotency, concurrency, rollback, remediation-1 adversarial ISO tests) unchanged.

**Step 2: Confirm zero boundary edits**

```bash
git status --short
```

Expected: modifications ONLY in `src/meal-types.ts`, `src/meal-reuse.test.ts`, `src/meal-reuse.integration.test.ts`, `src/mcp-reuse.integration.test.ts`. If `src/mcp.ts` or `src/meal-reuse.ts` show as modified, something went off-plan — stop and investigate.

### Task 6: Full gates, diff review, commit, push

**Step 1: Format + typecheck**

```bash
bun run format
bun run typecheck
```

Expected: prettier touches at most the four edited files; typecheck clean.

**Step 2: Full unit gate (no DB env in the command)**

```bash
bun run test:unit
```

Expected: 0 fail; DB suites report themselves skipped inside the unit gate as usual.

**Step 3: Full DB gate against the disposable database**

```bash
DATABASE_URL_TEST="$DISPOSABLE_DSN" DATABASE_URL="$DISPOSABLE_DSN" bun run test:db
```

Expected: all 12 suites in `scripts/test-db-gate.ts` pass with nonzero test counts (a zero-test suite fails the gate).

**Step 4: Diff review**

```bash
git status --short && git diff | cat
```

Expected changed files — EXACTLY these four, nothing else:

- `src/meal-types.ts` (validator range hardening)
- `src/meal-reuse.test.ts` (accept/reject table extension)
- `src/meal-reuse.integration.test.ts` (direct-service RED→GREEN test)
- `src/mcp-reuse.integration.test.ts` (transport RED→GREEN + boundary preservation tests)

`.hermes/plans/*` stay untracked; do not add them.

**Step 5: Commit and push**

```bash
git add src/meal-types.ts src/meal-reuse.test.ts \
        src/meal-reuse.integration.test.ts src/mcp-reuse.integration.test.ts
git commit -m "fix: slice 4 — reject 24:00 and out-of-range UTC offsets in strict reuse timestamps

Terra re-review (initial e12ae82, remediation 4063174) kept the HIGH
open: isStrictIsoTimestamp accepted shape-valid values that ECMAScript
parsers silently normalize — the ISO end-of-day alias 24:00:00 and UTC
offsets outside the legal zone window (+14:01, +15:00). The shared
validator now enforces hour <= 23 and offsets within [-12:00, +14:00]
with offset minutes 00-59, keeping Date.parse as a backstop only.
No boundary-file changes: both the reuse_meal_calculation zod
inputSchema and validateReuseCommand already call the shared gate.
RED->GREEN proven through real McpServer + InMemoryTransport and the
direct service path with unchanged domain row counts; legal extremes
+14:00, -12:00, +13:45, -00:00 and all prior ISO forms stay accepted."
git push
```

Expected: push succeeds to `main`.

---

## Completion criteria (all must hold)

1. Task 1-3 tests were observed RED before Task 4 and GREEN after; the Task 2 preservation test was green in BOTH phases.
2. `2026-08-06T24:00:00Z` (and offset/fraction variants) plus `+14:01`, `+15:00`, `-15:00` are rejected at the public transport with `Invalid arguments` and zero domain-row delta, and at the direct service with `MealEventValidationError` naming the field — each candidate first asserted `Date.parse`-parseable where the parser accepts it.
3. Legal boundary forms `+14:00`, `-12:00`, `+13:45`, `-00:00`, `23:59:59Z`, `00:00:00Z`, and every previously accepted form (`Z`, `+00:00`, `.123456Z`, `-05:00`) remain accepted; the `+14:00`/`-12:00` pair proven end-to-end over real MCP transport.
4. Full `bun run test:unit` and `bun run test:db` gates pass against the safety-checked disposable `nutrition_mcp_test` DSN (Preflight B), never the `.env` dev `DATABASE_URL`.
5. Diff touches exactly the four files in Task 6 step 4 — zero edits to `src/mcp.ts` and `src/meal-reuse.ts`.
