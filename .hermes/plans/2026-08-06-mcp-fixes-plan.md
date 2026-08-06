# MCP Fixes Implementation Plan (schema hardening + bundle conflict + MCP 2.0 assessment)

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Fix four known nutrition-mcp tool-schema/behavior defects (brief: `.hermes/plans/2026-08-06-mcp-fixes-brief.md`) test-first, and record the MCP 2.0 migration assessment.

**Architecture:** All four fixes are contract tightening at the MCP tool-registration layer (`src/mcp.ts`) plus one transactional conflict fix in `src/calculation-bundles.ts`. No DB migrations. Schema-advertisement changes are unit-tested by inspecting `client.listTools()` JSON Schema output (no DB needed); behavior changes are integration-tested in the existing DB-gated suites.

**Tech Stack:** Bun, TypeScript, zod 4.3.6, `@modelcontextprotocol/sdk` 1.29.0, PostgreSQL (pg), Hono.

**Test commands:**

- Unit gate (no DB): `bun run test:unit`
- DB gate (needs `DATABASE_URL_TEST` and, for legacy suite, `RUN_LEGACY_MEAL_DB_TESTS=1`): `bun run test:db`
- Typecheck: `bun run typecheck` — Format: `bunx prettier --write src/`

---

## Findings from code recon (read before implementing)

Current state as of commit on `main`, file sizes/lines verified 2026-08-06:

1. `append_meal_capture_message` registration: `src/mcp.ts:5062-5092`. The `message`
   param is `z.record(z.string(), z.unknown())` (line 5070). Server-side validation
   lives in `src/meal-capture-types.ts:177-200` (`validateCaptureMessage`) and throws
   `MealCaptureValidationError` (`"invalid meal capture: ..."`) from
   `appendCaptureMessage` (`src/meal-captures.ts:166-196`).
2. `commit_calculation_bundle` registration: `src/mcp.ts:5385-5424`. The bundle schema
   `CALCULATION_BUNDLE_INPUT_SCHEMA` is `src/mcp.ts:49-99`; `fingerprint` is already
   `z.string().min(1).optional()` (line 86) and `commitCalculationBundle`
   (`src/calculation-bundles.ts:327-346`) already auto-computes it when omitted
   (lines 332-336). ONLY the description text is missing → brief's Option B is a
   one-line `.describe()` change.
3. Duplicate-key root cause: `updateMeal` (`src/db.ts:407-448`) issues a
   `correctMealEvent` compatibility correction which (like `createMealEvent`) inserts
   placeholder rows into BOTH `meal_event_nutrition_results` (provenance
   `{"compatibility": true}`, `src/meal-events.ts:608-650`) AND
   `meal_event_canonical_results` (`src/meal-events.ts:674-682`) for the new version,
   leaving `meal_event_versions.calculation_bundle_fingerprint` NULL.
   `commitCalculationBundle` then passes its fingerprint-NULL guard
   (`src/calculation-bundles.ts:360-384`) and re-INSERTs canonical rows via
   `persistCanonicalPerScope` (`src/calculation-bundles.ts:237-286`), violating
   `UNIQUE (event_id, version, scope_key)` on `meal_event_canonical_results`
   (`db/migrations/002_food_tracking.sql:231`).
   NOTE: the existing passing test "public calculation MCP round-trips…"
   (`src/legacy-meal-tools.integration.test.ts:1362+`) does NOT cover this because it
   seeds the version with raw SQL (no compat placeholder rows).
4. `confirm_meal_capture` registration: `src/mcp.ts:5300-5359`. **The brief's premise
   is partially stale**: `capture_id` and `confirmation` ARE already declared required
   (`z.string().min(1)`, lines 5312-5316). What is genuinely missing: UUID constraint
   on `capture_id` and the confirmation enum. See escalation E2 below.

### Escalations (contradictions between brief and code — decided here, flag to owner in the handoff)

- **E1 — `received_at` is NOT server-required.** Brief P1 says the server requires
  `received_at`; in fact `validateCaptureMessage` only rejects it when present-and-invalid
  (`isValidDate` returns true for null/undefined, `src/meal-capture-types.ts:146-152`) and
  `appendCaptureMessage` defaults to `now()` (`src/meal-captures.ts:192`). Making it
  MCP-required is a client-facing tightening, not a bug fix. **Decision: follow the brief**
  (require it — accurate receipt time is the tool's purpose) but call it out in the PR
  description as a deliberate contract tightening.
- **E2 — enum on `confirmation` is stricter than the handler.** The handler accepts
  case-insensitive/whitespace-padded values via `isExplicitConfirmation`
  (`src/meal-captures.ts:32-34`: `trim().toLowerCase()`), so `z.enum` rejects "Add "
  that the server would accept today. Do NOT use `z.preprocess` (its JSON-Schema
  conversion is unreliable). **Decision: follow the brief** — plain
  `z.enum(["добавь", "add", "confirm"])` with a description noting lowercase; the
  calling agent normalizes. Flag in PR.
- **E3 — P3 semantics decision (brief asked us to pick):** keep `update_meal`'s
  compatibility write (projections/exports depend on canonical rows existing for the
  current version — removing them breaks `export_meals`/`get_meals` values), and make
  `commit_calculation_bundle` REPLACE the compatibility placeholders transactionally.
  Deleting placeholder rows does not violate the "corrections are insert-only" invariant
  (`src/meal-events.ts:8-16`): that invariant protects historical _versions_; the bundle
  commit already mutates the same version row (`calculation_bundle_fingerprint` NULL →
  value), and placeholders are explicitly marked `{"compatibility": true}` throwaways.
  Bonus: replacement also unblocks `deriveAggregateProvenance`
  (`src/meal-events.ts:281-343`), which requires EXACTLY 3 event-scope provider rows —
  a leftover compat `own` row would make it 4 and permanently pin provenance at
  incomplete.

---

## Task 1: Failing unit test — `append_meal_capture_message` advertises required message fields

**Objective:** Assert the tool's published JSON Schema requires `external_message_id`, `kind` (4-value enum), `received_at`.

**Files:**

- Test: `src/mcp.test.ts` (append a new `describe` block at the end of the file; reuse the listTools harness pattern from `src/mcp.test.ts:1850-1865`)

**Step 1: Write failing test**

```typescript
// Schema-advertisement contract for the capture/bundle tools: clients must be
// able to see required fields + enums from tools/list alone (no 400 guessing).
describe("MCP tool input schema advertisement", () => {
    async function listToolSchemas() {
        const server = new McpServer(
            { name: "schema-test", version: "0.0.0" },
            { capabilities: { tools: {}, resources: {} } },
        );
        registerTools(server, "u1", true, null);
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "c", version: "0.0.0" });
        await Promise.all([server.connect(st), client.connect(ct)]);
        const { tools } = await client.listTools();
        await client.close();
        await server.close();
        return new Map(tools.map((t) => [t.name, t.inputSchema]));
    }

    test("append_meal_capture_message requires message identity fields", async () => {
        const schemas = await listToolSchemas();
        const schema = schemas.get("append_meal_capture_message") as any;
        expect(schema.required).toEqual(
            expect.arrayContaining(["capture_id", "message"]),
        );
        const message = schema.properties.message;
        expect(message.required).toEqual(
            expect.arrayContaining([
                "external_message_id",
                "kind",
                "received_at",
            ]),
        );
        expect(message.properties.kind.enum).toEqual([
            "text",
            "answer",
            "photo",
            "audio",
        ]);
        expect(message.properties.received_at.description).toMatch(/ISO/i);
        // Extra keys (e.g. platform metadata) must stay allowed.
        expect(message.additionalProperties).not.toBe(false);
    });
});
```

**Step 2: Run test to verify failure**

Run: `bun test src/mcp.test.ts -t "append_meal_capture_message requires"`
Expected: FAIL — `message.required` is undefined (current schema is a bare record).

**Step 3-5:** implementation is Task 2; then re-run, then commit both together (see Task 2 Step 5).

---

## Task 2: Implement `CAPTURE_MESSAGE_INPUT_SCHEMA` (Problem 1)

**Objective:** Replace the untyped `message` record with a typed loose object.

**Files:**

- Modify: `src/mcp.ts:49` (insert new constant just BEFORE `CALCULATION_BUNDLE_INPUT_SCHEMA`)
- Modify: `src/mcp.ts:5070` (use the constant)

**Step 1: Add the schema constant**

Insert above `const CALCULATION_BUNDLE_INPUT_SCHEMA` (mcp.ts:49):

```typescript
// MCP-advertised shape for append_meal_capture_message's `message` param.
// Mirrors validateCaptureMessage (src/meal-capture-types.ts): the server
// rejects payloads missing these fields with 400 "invalid meal capture", so
// the tool schema must declare them. Loose object: platform-specific extra
// keys are retained in raw_metadata flows and must not be rejected here.
const CAPTURE_MESSAGE_INPUT_SCHEMA = z.looseObject({
    external_message_id: z
        .string()
        .min(1)
        .describe(
            "Stable per-message identifier from the source platform; replays with the same id are deduplicated.",
        ),
    kind: z.enum(["text", "answer", "photo", "audio"]),
    received_at: z
        .string()
        .refine((s) => !Number.isNaN(Date.parse(s)), {
            message: "received_at must be a parseable timestamp",
        })
        .describe("ISO 8601 timestamp when the message was received."),
    text: z.string().nullable().optional(),
    raw_metadata: z.record(z.string(), z.unknown()).optional(),
});
```

(zod 4.3.6 has `z.looseObject`; matches the `Date.parse` refine pattern already used at `src/mcp.ts:5442-5444`.)

**Step 2: Use it in the tool registration**

At `src/mcp.ts:5070` replace:

```typescript
                message: z.record(z.string(), z.unknown()),
```

with:

```typescript
                message: CAPTURE_MESSAGE_INPUT_SCHEMA,
```

The handler cast at line 5079 (`args.message as unknown as CaptureMessageInput`) stays valid and unchanged.

**Step 3: Run test to verify pass**

Run: `bun test src/mcp.test.ts -t "append_meal_capture_message requires"`
Expected: PASS. Then `bun run typecheck` — expected: clean.

**Step 4: Run full unit gate**

Run: `bun run test:unit`
Expected: all pass (watch `src/mcp-food-tracking.test.ts` DB-skipped notices — fine).

**Step 5: Commit**

```bash
git add src/mcp.ts src/mcp.test.ts
git commit -m "fix(mcp): declare required fields on append_meal_capture_message schema"
```

---

## Task 3: DB-gated regression test — invalid message rejected at schema layer

**Objective:** Prove a message missing `external_message_id` now fails at MCP arg validation (never reaches the handler / DB).

**Files:**

- Test: `src/mcp-food-tracking.test.ts` (uses `withTools` harness, lines 74-113)

**Step 1: Write the test** (inside the existing DB describe block, near the other capture tests ~line 1191)

```typescript
test("append_meal_capture_message rejects schema-invalid message before the handler", async () => {
    await withTools(pool, async (call) => {
        const started = await call("start_meal_capture", {
            conversation_key: "schema-reject",
            idempotency_key: "schema-reject-1",
        });
        const { capture_id } = JSON.parse(started.content[0]!.text);
        const bad = await call("append_meal_capture_message", {
            capture_id,
            message: { kind: "text", text: "no id" }, // missing external_message_id + received_at
        });
        expect(bad.isError).toBe(true);
        // No message row was persisted.
        const rows = await pool.query(
            "SELECT count(*) FROM meal_capture_messages",
        );
        expect(rows.rows[0].count).toBe("0");
    });
});
```

(Note: SDK arg-validation failures surface as `isError: true` results through `client.callTool`; if the SDK throws `McpError` instead in this version, wrap in `await expect(...).rejects.toThrow(/external_message_id/)` — check the actual behavior on first run and keep whichever assertion matches.)

**Step 2: Run**

Run: `DATABASE_URL_TEST=<test-db-url> bun test src/mcp-food-tracking.test.ts -t "rejects schema-invalid message"`
Expected: PASS (schema from Task 2 already rejects it). This is a pin-down test, not red-green — it exists to catch future schema loosening.

**Step 3: Commit**

```bash
git add src/mcp-food-tracking.test.ts
git commit -m "test(mcp): pin schema-level rejection of invalid capture messages"
```

---

## Task 4: `commit_calculation_bundle` fingerprint description (Problem 2, Option B)

**Objective:** Document fingerprint semantics in the advertised schema. (Recon shows Option A's "truly optional + server computes" is ALREADY the behavior; only the description is missing.)

**Files:**

- Test: `src/mcp.test.ts` (extend Task 1's describe block)
- Modify: `src/mcp.ts:86`

**Step 1: Write failing test**

```typescript
test("commit_calculation_bundle documents fingerprint semantics", async () => {
    const schemas = await listToolSchemas();
    const schema = schemas.get("commit_calculation_bundle") as any;
    const fingerprint = schema.properties.bundle.properties.fingerprint;
    expect(schema.properties.bundle.required ?? []).not.toContain(
        "fingerprint",
    );
    expect(fingerprint.description).toMatch(/omit/i);
    expect(fingerprint.description).toMatch(/server/i);
});
```

**Step 2: Run to verify failure**

Run: `bun test src/mcp.test.ts -t "documents fingerprint semantics"`
Expected: FAIL — no description present.

**Step 3: Implement** — at `src/mcp.ts:86` replace:

```typescript
    fingerprint: z.string().min(1).optional(),
```

with:

```typescript
    fingerprint: z
        .string()
        .min(1)
        .optional()
        .describe(
            "Computed by the server; omit to let the server compute it from the bundle content. If provided, it must exactly match the server-computed fingerprint or the commit fails with 'bundle fingerprint mismatch'.",
        ),
```

**Step 4: Run to verify pass**

Run: `bun test src/mcp.test.ts -t "documents fingerprint semantics"` → PASS; `bun run test:unit` → all pass.

**Step 5: Commit**

```bash
git add src/mcp.ts src/mcp.test.ts
git commit -m "docs(mcp): document fingerprint omission semantics on commit_calculation_bundle"
```

---

## Task 5: Failing integration test — bundle commit after `update_meal` (Problem 3 repro)

**Objective:** Reproduce the `duplicate key value violates unique constraint` crash end-to-end.

**Files:**

- Test: `src/calculation-bundles.integration.test.ts` (has `makeBundle()` helper and the migration/reset harness, lines 37-69)

**Step 1: Write failing test** — add inside the `describeDb` block. Simulate the compat correction the way `correctMealEvent` leaves the DB (placeholder provider row + canonical row, NULL fingerprint):

```typescript
test("commit over a compatibility version replaces placeholders instead of crashing", async () => {
    const eventId = "00000000-0000-4000-8000-000000000001";
    // Simulate what update_meal's compatibility correction persists for a
    // new version: one placeholder 'own' provider row + one canonical row,
    // calculation_bundle_fingerprint left NULL (see src/meal-events.ts).
    await pool.query(
        `INSERT INTO meal_event_nutrition_results
                (event_id, version, ordinal, provider, source_id, status,
                 request_fingerprint, algorithm_version, raw_payload, provenance, calories)
             VALUES ($1, 1, NULL, 'own', 'legacy:compat', 'succeeded',
                     'legacy:compat', 'legacy-compat',
                     '{"compatibility": true}', '{"compatibility": true}', 555)`,
        [eventId],
    );
    await pool.query(
        `INSERT INTO meal_event_canonical_results
                (event_id, version, ordinal, status, consensus_status,
                 calories, policy_version, audit_evidence)
             VALUES ($1, 1, NULL, 'ready', 'insufficient_data',
                     555, 'legacy-compat', '{"compatibility": true}')`,
        [eventId],
    );

    const bundle = makeBundle();
    const result = await commitCalculationBundle(pool, bundle);
    expect(result.deduplicated).toBe(false);
    expect(result.canonical.nutrients.calories).toBe(505);

    // Placeholders are gone; exactly the bundle's 3 provider rows remain.
    const providers = await pool.query(
        `SELECT provider, source_id FROM meal_event_nutrition_results
              WHERE event_id = $1 AND version = 1 AND ordinal IS NULL
              ORDER BY provider`,
        [eventId],
    );
    expect(providers.rows).toHaveLength(3);
    expect(providers.rows.some((r) => r.source_id === "legacy:compat")).toBe(
        false,
    );
    // Exactly one canonical row per scope (event scope here).
    const canonical = await pool.query(
        `SELECT count(*) FROM meal_event_canonical_results
              WHERE event_id = $1 AND version = 1`,
        [eventId],
    );
    expect(canonical.rows[0].count).toBe("1");
});
```

(Adjust the two INSERTs' column lists if a NOT NULL column is missed on first run — the schema is `db/migrations/002_food_tracking.sql:171-232` plus `004_calculation_bundles.sql` additions. `basis`/`units` are nullable per migration 004.)

**Step 2: Run to verify failure**

Run: `DATABASE_URL_TEST=<test-db-url> bun test src/calculation-bundles.integration.test.ts -t "replaces placeholders"`
Expected: FAIL — `duplicate key value violates unique constraint` (canonical UNIQUE (event_id, version, scope_key)).

**Step 3: Commit nothing yet** — fix in Task 6, commit together.

---

## Task 6: Fix `commitCalculationBundle` placeholder replacement (Problem 3)

**Objective:** Inside the existing transaction, delete compatibility placeholders before inserting the bundle's rows. Per escalation E3: `update_meal` behavior is unchanged.

**Files:**

- Modify: `src/calculation-bundles.ts:384` (immediately after the `if (existing) { ... return ...deduplicated... }` block, before the `for (const result of bundle.results)` loop at line 385)

**Step 1: Implement**

Insert after line 384 (`}` closing the `if (existing)` dedupe block):

```typescript
// A compatibility write (log_meal / update_meal correction) leaves
// placeholder provider rows (provenance {"compatibility": true}) and
// canonical rows for this version with a NULL bundle fingerprint. The
// explicit bundle is the authoritative provenance for the version:
// replace the placeholders inside this same transaction, or the
// canonical INSERT below hits UNIQUE (event_id, version, scope_key).
// Reached only when calculation_bundle_fingerprint IS NULL (a non-NULL
// fingerprint returned via the dedupe/conflict paths above), so every
// row deleted here is a recomputable compatibility placeholder.
await client.query(
    `DELETE FROM meal_event_nutrition_results
              WHERE event_id = $1 AND version = $2
                AND provenance @> '{"compatibility": true}'::jsonb`,
    [bundle.event_id, bundle.version],
);
await client.query(
    `DELETE FROM meal_event_canonical_results
              WHERE event_id = $1 AND version = $2`,
    [bundle.event_id, bundle.version],
);
```

**Step 2: Run the new test**

Run: `DATABASE_URL_TEST=<test-db-url> bun test src/calculation-bundles.integration.test.ts -t "replaces placeholders"`
Expected: PASS.

**Step 3: Run the whole DB gate (regression check on idempotency/tamper/rollback tests)**

Run: `DATABASE_URL_TEST=<test-db-url> RUN_LEGACY_MEAL_DB_TESTS=1 bun run test:db`
Expected: all pass. Pay attention to `src/legacy-meal-tools.integration.test.ts` (update_meal flows) and `src/calculation-acceptance.integration.test.ts`.

**Step 4: Commit**

```bash
git add src/calculation-bundles.ts src/calculation-bundles.integration.test.ts
git commit -m "fix(bundles): replace compatibility placeholders on commit_calculation_bundle instead of crashing on duplicate key"
```

---

## Task 7: End-to-end test — `update_meal` → `commit_calculation_bundle` through the MCP tools (Problem 3, tool-level)

**Objective:** Cover the exact reported flow through tool calls, including provenance readback.

**Files:**

- Test: `src/legacy-meal-tools.integration.test.ts` (add a `test.serial` near the "public calculation MCP round-trips" test, ~line 1362; reuse its `publicBundle(eventId, version, calories, tag)` helper and `callTools`)

**Step 1: Write the test**

```typescript
test.serial(
    "commit_calculation_bundle succeeds for a version created by update_meal",
    async () => {
        let mealId = "";
        await callTools(async (call) => {
            const logged = await call("log_meal", {
                description: "bundle-after-update meal",
                calories: 400,
                logged_at: "2026-08-06T12:00:00.000Z",
                idempotency_key: "bundle-after-update",
            });
            expect(logged.isError).not.toBe(true);
            const row = await pool.query(
                "SELECT id FROM meal_events WHERE user_id = $1 AND idempotency_key = $2",
                ["u1", "bundle-after-update"],
            );
            mealId = row.rows[0]!.id as string;

            const updated = await call("update_meal", {
                id: mealId,
                calories: 505,
            });
            expect(updated.isError).not.toBe(true);

            // Version 2 exists via the compatibility correction; the
            // explicit bundle for v2 must commit, not crash.
            const committed = await call("commit_calculation_bundle", {
                bundle: publicBundle(mealId, 2, 505, "after-update"),
            });
            expect(committed.isError).not.toBe(true);
            const output = CALCULATION_BUNDLE_OUTPUT_SCHEMA.parse(
                committed.structuredContent,
            );
            expect(output).toMatchObject({
                event_id: mealId,
                version: 2,
                deduplicated: false,
                compatibility: false,
            });
        });
    },
);
```

(`publicBundle`'s exact signature: confirm against its definition in this file before writing — search `function publicBundle` / `const publicBundle`.)

**Step 2: Run**

Run: `DATABASE_URL_TEST=<test-db-url> RUN_LEGACY_MEAL_DB_TESTS=1 bun test src/legacy-meal-tools.integration.test.ts -t "succeeds for a version created by update_meal"`
Expected: PASS (fix landed in Task 6). Without Task 6 this test reproduces the reported crash — you can cherry-run it before Task 6 if you want a second red confirmation.

**Step 3: Commit**

```bash
git add src/legacy-meal-tools.integration.test.ts
git commit -m "test(mcp): cover commit_calculation_bundle after update_meal end to end"
```

---

## Task 8: `confirm_meal_capture` schema constraints (Problem 4)

**Objective:** Advertise `capture_id` as UUID and `confirmation` as the 3-value enum. (Required-ness already exists — see recon note 4 / escalation E2.)

**Files:**

- Test: `src/mcp.test.ts` (extend Task 1's describe block)
- Modify: `src/mcp.ts:5312-5316` (inputSchema) and `src/mcp.ts:5324` (drop the now-unneeded cast)

**Step 1: Write failing test**

```typescript
test("confirm_meal_capture constrains capture_id and confirmation", async () => {
    const schemas = await listToolSchemas();
    const schema = schemas.get("confirm_meal_capture") as any;
    expect(schema.required).toEqual(
        expect.arrayContaining(["capture_id", "confirmation"]),
    );
    expect(schema.properties.capture_id.format).toBe("uuid");
    expect(schema.properties.confirmation.enum).toEqual([
        "добавь",
        "add",
        "confirm",
    ]);
});
```

**Step 2: Run to verify failure**

Run: `bun test src/mcp.test.ts -t "confirm_meal_capture constrains"`
Expected: FAIL — no format/enum on the current plain strings.

**Step 3: Implement** — at `src/mcp.ts:5312-5316` replace:

```typescript
            inputSchema: {
                capture_id: z.string().min(1),
                confirmation: z.string().min(1),
                event_idempotency_key: z.string().optional(),
            },
```

with:

```typescript
            inputSchema: {
                capture_id: z
                    .string()
                    .uuid()
                    .describe("UUID returned by start_meal_capture."),
                confirmation: z
                    .enum(["добавь", "add", "confirm"])
                    .describe(
                        "The explicit user add command, lowercase. Normalize case/whitespace before calling.",
                    ),
                event_idempotency_key: z.string().optional(),
            },
```

Then at `src/mcp.ts:5319-5325` the handler spread simplifies — `confirmation` is now typed as the exact union, so replace:

```typescript
                {
                    ...args,
                    confirmation: args.confirmation as "добавь",
                },
```

with:

```typescript
                args,
```

(`ConfirmCaptureCommand.confirmation` is `"добавь" | "add" | "confirm"`, `src/meal-capture-types.ts:59-63` — the inferred type now matches exactly.)

**Step 4: Run to verify pass**

Run: `bun test src/mcp.test.ts -t "confirm_meal_capture constrains"` → PASS.
Run: `bun run typecheck` → clean.
Run: `DATABASE_URL_TEST=<test-db-url> bun run test:db` → all pass (existing confirm tests use lowercase `"add"`/`"добавь"` and UUID capture ids, so no fixture churn expected; if any test sends a non-UUID capture id to confirm, that test must be updated to use a real capture id — do not loosen the schema).

**Step 5: Commit**

```bash
git add src/mcp.ts src/mcp.test.ts
git commit -m "fix(mcp): constrain confirm_meal_capture schema (uuid + confirmation enum)"
```

---

## Task 9: Full gates + formatting + plan index

**Step 1:** `bun run typecheck` → clean.
**Step 2:** `bun run test:unit` → all pass.
**Step 3:** `DATABASE_URL_TEST=<test-db-url> RUN_LEGACY_MEAL_DB_TESTS=1 bun run test:db` → all pass.
**Step 4:** `bunx prettier --write src/ && bunx prettier --check .` → clean.
**Step 5:** Add this plan to `.hermes/plans/INDEX.md` following its existing format.
**Step 6: Commit**

```bash
git add .hermes/plans/
git commit -m "docs: mcp fixes plan + index"
```

---

## MCP 2.0 migration assessment (research deliverable — no implementation tasks)

### What "MCP 2.0" is

Two coupled releases (July 2026):

1. **Spec revision `2026-07-28`** (changelog: modelcontextprotocol.io/specification/2026-07-28/changelog):
    - Protocol is now **stateless**: `initialize`/`initialized` handshake and `Mcp-Session-Id` header removed; protocol version + client capabilities travel in `_meta` on every request (`io.modelcontextprotocol/protocolVersion`, `.../clientCapabilities`, `.../clientInfo`).
    - Streamable HTTP POSTs must carry `Mcp-Method` / `Mcp-Name` headers.
    - All results carry a required `resultType` (`"complete"` | `"input_required"`).
    - `tools/list` etc. must return `ttlMs` + `cacheScope` (CacheableResult).
    - `ping`, `logging/setLevel`, roots list-changed removed; **Roots, Sampling, Logging deprecated**.
    - Tasks moved to an extension (`io.modelcontextprotocol/tasks`).
    - `inputSchema`/`outputSchema` loosened to full JSON Schema 2020-12.
2. **TypeScript SDK v2**: the monolithic `@modelcontextprotocol/sdk` is retired in favor of split packages — `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, `@modelcontextprotocol/core` (Zod `*Schema` constants live here), plus framework adapters (Node, Express, **Hono**, Fastify). ESM-only, Node 20+/**Bun** supported. `registerTool` is retained (codemod renames v1 `.tool()` — we already use `registerTool` everywhere). HTTP entry point becomes `createMcpHandler` with a per-request server factory; it serves BOTH `2026-07-28` and legacy `2025-11-25` traffic from one endpoint. Official codemod: `npx @modelcontextprotocol/codemod@beta v1-to-v2 .` and migration guide: https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html

### Current dependency state (verified in repo)

- `package.json:42` → `@modelcontextprotocol/sdk: ^1.29.0`; `bun.lock` resolves **1.29.0** (a v1, pre-2.0 SDK; supports spec ≤ 2025-11-25). v1 keeps receiving bug fixes/security updates ≥ 6 months post-v2.
- `zod` resolves **4.3.6** — v2 SDK accepts Standard Schema libraries incl. zod 4, so our ~45 tool schemas carry over as-is.
- Transitives of note: `zod-to-json-schema@3.25.1`, SDK-internal `hono@4.12.28` (we also directly use `hono ^4.12.30`).

### How much of `src/mcp.ts` changes

| Area                                                                     | Impact                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~45 `server.registerTool(...)` registrations (mcp.ts:1712-5461)          | **None to minimal** — `registerTool` API survives; zod 4 schemas survive. Codemod handles import renames.                                                                                                                                                                                                                                                                          |
| Imports (mcp.ts:1-47, test files)                                        | Mechanical: `sdk/server/mcp.js` → `@modelcontextprotocol/server`; `Client`/`InMemoryTransport` → `@modelcontextprotocol/client`; Zod schema constants → `@modelcontextprotocol/core`.                                                                                                                                                                                              |
| Transport + `handleMcp` (mcp.ts:5544-5585)                               | Rework: `WebStandardStreamableHTTPServerTransport` → `createMcpHandler(factory)` with the Hono adapter. We ALREADY build a fresh McpServer per request, run `sessionIdGenerator: undefined`, and 405 GET/DELETE — the v2 stateless model is exactly our current architecture, so this shrinks code (the hand-rolled 405/SSE-refusal rationale block becomes SDK-default behavior). |
| `src/index.ts` route wiring                                              | Small: pass the handler the raw Request as today.                                                                                                                                                                                                                                                                                                                                  |
| Tests (`mcp.test.ts`, `mcp-food-tracking.test.ts`, others importing SDK) | Mechanical import moves; `InMemoryTransport` pairing pattern persists in v2.                                                                                                                                                                                                                                                                                                       |
| MCP Apps widgets (`uiMeta`, `_meta.ui`, mcp.ts:730+, widgets.ts)         | **Open risk — verify before committing to a date.** MCP Apps/`_meta` ui extension support in SDK v2 must be confirmed against the v2 extensions surface; this is the one subsystem that could add days.                                                                                                                                                                            |
| Roots/Sampling/Logging                                                   | Not used by this server — deprecations are a no-op for us.                                                                                                                                                                                                                                                                                                                         |

### Effort estimate

- Codemod + import/package swap + transport rewrite + green unit gate: **1 day**.
- DB-gated suites, inspector re-verification (`bunx @modelcontextprotocol/inspector` version bump), widget harness: **0.5-1 day**.
- MCP Apps `_meta.ui` verification/porting on v2: **0.5-2 days** (unknown until spiked).
- **Total: roughly 2-4 dev-days**, dominated by the widgets unknown. Recommended sequencing: land the four v1 fixes in this plan first (they are orthogonal and v1 stays supported), then run a 2-hour spike: codemod on a branch + boot against MCP Inspector + one widget round-trip, and only then commit to the migration window. Note client-compat: v2's `createMcpHandler` still serves `2025-11-25` clients, so migrating the server does not force Hermes-side client changes.

---

## Review checklist

- [ ] Tasks sequential, each 2-5 min
- [ ] All paths/line numbers verified against current tree (they were, 2026-08-06)
- [ ] TDD: red before green for Tasks 1/4/5/8 (Task 3/7 are pin-down/e2e)
- [ ] Escalations E1-E3 surfaced to the brief owner in the PR description
- [ ] No DB migration required; no behavior change to update_meal
