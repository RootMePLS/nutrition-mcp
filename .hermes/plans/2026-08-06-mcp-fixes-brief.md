# Brief: Fix known issues in nutrition-mcp + assess MCP 2.0 migration

## Problem 1: `append_meal_capture_message` schema missing required fields

**File:** `src/mcp.ts`

**Symptom:** The MCP tool schema for `append_meal_capture_message` has `message` as a plain object with `additionalProperties: {}` and no `required` fields. But the server internally requires:

- `external_message_id` (non-empty string)
- `kind` — must be one of `["text", "answer", "photo", "audio"]`
- `received_at` — valid ISO timestamp

Without these, the server returns 400 `"invalid meal capture"` with specific errors. The tool's MCP schema should declare these as required so clients know what to send.

**What to fix:**

1. In `src/mcp.ts`, update the Zod/type schema for the `message` parameter of `append_meal_capture_message` to declare `external_message_id`, `kind`, and `received_at` as required fields with proper types/constraints.
2. The `kind` field should have a proper enum of the 4 values.
3. The `received_at` field should have a string format hint.
4. Add validation tests for the new schema.

**Files:**

- `src/mcp.ts` — tool registration
- `src/` — possibly helper types

## Problem 2: `commit_calculation_bundle` requires valid fingerprint but schema allows invalid ones

**Files:** `src/mcp.ts`, `src/calculation-bundles.ts`

**Symptom:** When calling `commit_calculation_bundle`, if the caller passes a `fingerprint` that doesn't match the server-computed one, the server returns `"bundle fingerprint mismatch"`. The MCP schema for the bundle's `fingerprint` field doesn't clarify that it should be omitted (let server compute) or must match.

**What to fix:**
Two options (pick one):

- **Option A:** Make `fingerprint` truly optional in the MCP schema so clients always omit it; the server always computes it from the bundle content.
- **Option B:** Keep `fingerprint` in the schema but add clear description text: "Computed by the server; omit to let the server compute. If provided, must match the server-computed fingerprint."

**Files:**

- `src/mcp.ts` — tool registration / schema for `commit_calculation_bundle`
- `src/calculation-bundles.ts` — validation logic

## Problem 3: `commit_calculation_bundle` crashes with `duplicate key` when called after `update_meal`

**Symptom:** After `update_meal` creates version 2, calling `commit_calculation_bundle` for version 2 fails with `"duplicate key value violates unique constraint"` because `update_meal` already wrote a calculation bundle for that version.

**What to check/fix:**

1. Investigate if `update_meal` currently auto-creates a calculation bundle.
2. Decide: should `update_meal` NOT create a bundle (leaving it to explicit `commit_calculation_bundle`), or should `commit_calculation_bundle` handle the case where a bundle already exists (returning the existing one)?
3. The expected semantics: `commit_calculation_bundle` is the explicit tool for attaching provider results. If `update_meal` also writes a bundle, they conflict.

**Files:**

- `src/mcp.ts` — `update_meal` tool registration
- `src/db.ts` — meal update logic

## Problem 4: `confirm_meal_capture` returns no `inputSchema` in MCP schema

**File:** `src/mcp.ts`

**Symptom:** The MCP schema for `confirm_meal_capture` has `required: []` — the tool's parameter schema doesn't advertise `capture_id` and `confirmation` as required (though they are required at the handler level).

**What to fix:**
Add proper Zod schema for `confirm_meal_capture` parameters:

- `capture_id`: required string (UUID)
- `confirmation`: required string with enum `["добавь", "add", "confirm"]`

**Files:**

- `src/mcp.ts` — tool registration

## Side topic: MCP 2.0 migration assessment

Research and assess:

1. What changes does MCP 2.0 introduce (transport, schema, auth, capabilities)?
2. How much of the existing `src/mcp.ts` tool registrations would need to change?
3. Does the current `@modelcontextprotocol/sdk` version support MCP 2.0?
4. Rough effort estimate for the migration.

Check:

- `package.json` for current SDK version
- `bun.lock` or lockfile for transitive deps
- The MCP SDK changelog / migration guide
- Web search for "MCP 2.0 migration" or "modelcontextprotocol sdk 2.0"
