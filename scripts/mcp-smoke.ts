// Local MCP SDK smoke: drives the real server tools over an in-memory MCP
// transport against the approved disposable test database. It fails closed
// before any pool, clock freeze, or scratch state unless DATABASE_URL and
// DATABASE_URL_TEST are exactly equal AND the parsed URL's database pathname
// decodes to exactly `nutrition_mcp_test`; DSN equality alone never
// authorizes the DROP SCHEMA below.
//
// Covers the full migration chain: the schema reset below replays
// 001-010. The public surface is asserted with a client.listTools()
// inventory check (all reuse/supplement tools advertised, 66+ total).
// Covers the legacy surface end to end: log, bulk import, update, all eight
// legacy reads (get_meals_by_date, get_meals_today, get_meals_by_date_range,
// search_meals, get_nutrition_summary, get_goal_progress, get_trends,
// get_meal_patterns), export, delete, plus the capture media round trip
// (start_meal_capture -> attach_meal_capture_media with a tiny PNG fixture ->
// save_meal_capture_draft -> confirm_meal_capture) re-read through
// get_meal_capture and get_meals_by_date, plus a minimal supplement
// transport round trip (create_supplement_product -> log_supplement_intake
// with snack linkage -> get_calculation_provenance -> get_supplement_intakes).
// Exits non-zero on the first failed step.
//
//   DATABASE_URL=postgres://localhost/nutrition_mcp_test \
//   DATABASE_URL_TEST=postgres://localhost/nutrition_mcp_test \
//   bun run scripts/mcp-smoke.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setSystemTime } from "bun:test";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../src/mcp.js";
import { createMediaStore } from "../src/media-store.js";
import { closePool } from "../src/db.js";
import { flushAnalytics } from "../src/analytics.js";

// Fail closed before pool construction, clock freeze, or scratch creation.
// Refusal output is explicit and non-secret: it names the reason and the
// (non-secret) parsed database name only, never the DSN, which may carry
// credentials.
function refuse(reason: string): never {
    console.error(`MCP smoke refused: ${reason}`);
    process.exit(2);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || process.env.DATABASE_URL_TEST !== databaseUrl) {
    refuse(
        "DATABASE_URL and DATABASE_URL_TEST must both be set to the same " +
            "disposable PostgreSQL database.",
    );
}
const APPROVED_DATABASE = "nutrition_mcp_test";
let databaseName: string;
try {
    databaseName = decodeURIComponent(
        new URL(databaseUrl).pathname.replace(/^\/+/, ""),
    );
} catch {
    refuse("DATABASE_URL could not be parsed as a PostgreSQL URL.");
}
if (databaseName !== APPROVED_DATABASE) {
    refuse(
        `database name ${JSON.stringify(databaseName)} is not the approved ` +
            `disposable test database ${JSON.stringify(APPROVED_DATABASE)}; ` +
            "equal DSNs alone do not authorize a destructive schema reset.",
    );
}

// Unique per run so idempotency keys and the smoke-owned exports path never
// collide with a prior smoke run or any other operator's exports.
const RUN = `r${Math.random().toString(36).slice(2, 10)}`;
const USER = `smoke-user-${RUN}`;
// Freeze the clock at today's UTC noon: get_meals_today and the trend windows
// resolve "today" server-side, so a fixed noon keeps the smoke deterministic
// across the UTC midnight boundary (same approach as the legacy regression
// test). Restored in the finally below.
const DAY = new Date().toISOString().slice(0, 10);
setSystemTime(new Date(`${DAY}T12:00:00.000Z`));

const exportsDir = join(
    fileURLToPath(new URL("..", import.meta.url)),
    "exports",
    USER,
);
// Smoke-owned exports directory: exports/<unique per-run smoke user>. Every
// cleanup path (normal exit, failure, process exit) removes only this
// directory — never the repository-wide exports root — so unrelated users'
// exports always survive.
// Scratch media root for the capture attach path; removed in the finally.
const mediaRoot = mkdtempSync(join(tmpdir(), "nutrition-mcp-smoke-media-"));
// Belt-and-braces: whatever path the process exits by (including a setup
// failure before the try below), no scratch survives on the filesystem.
process.on("exit", () => {
    rmSync(exportsDir, { recursive: true, force: true });
    rmSync(mediaRoot, { recursive: true, force: true });
});

// Tiny PNG fixture: a known-valid, independently decodable 1x1 RGBA image
// (68 bytes; verified with the macOS image decoder, `sips`, as 1x1). The
// server decodes it, checks the MIME allow-list and hashes it.
const PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x00, 0x02, 0x00,
    0x00, 0x05, 0x00, 0x01, 0x7a, 0x5e, 0xab, 0x3f, 0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");
const PNG_SHA256 = new Bun.CryptoHasher("sha256")
    .update(PNG_BYTES)
    .digest("hex");

// Direct pre-attachment fixture check: parse the PNG container ourselves and
// require the 8-byte signature, an IHDR first chunk, and exactly 1x1
// dimensions at minimum, so a broken fixture fails the smoke before the
// attach path is ever exercised.
function pngDimensions(
    bytes: Uint8Array,
): { width: number; height: number } | null {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.byteLength < 8 + 8 + 13) return null;
    if (!signature.every((b, i) => bytes[i] === b)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(8) !== 13) return null; // IHDR chunk length
    if (
        String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !==
        "IHDR"
    ) {
        return null;
    }
    return { width: view.getUint32(16), height: view.getUint32(20) };
}
const fixtureDimensions = pngDimensions(PNG_BYTES);

interface ToolResult {
    isError?: boolean;
    content: { type: string; text?: string }[];
    structuredContent?: Record<string, unknown>;
}

function check(step: string, ok: boolean, detail = ""): void {
    if (!ok) {
        // Throw (not process.exit) so the finally below still restores the
        // clock and removes the exports/media scratch on failure.
        throw new Error(`SMOKE FAIL [${step}] ${detail}`);
    }
    console.log(`smoke ok: ${step}`);
}

// Fixture gate: runs before any pool or tool work so an invalid payload can
// never reach the attach path.
check(
    "png fixture decodes as 1x1",
    fixtureDimensions !== null &&
        fixtureDimensions.width === 1 &&
        fixtureDimensions.height === 1,
    `fixture_bytes=${PNG_BYTES.byteLength} ` +
        `dimensions=${JSON.stringify(fixtureDimensions)}`,
);

const pool = new Pool({ connectionString: databaseUrl });

// Reset to a fresh schema from the real migrations.
const client0 = await pool.connect();
try {
    await client0.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    for (const migration of [
        "001_initial_schema.sql",
        "002_food_tracking.sql",
        "003_meal_captures.sql",
        "004_calculation_bundles.sql",
        "005_calculation_corrections.sql",
        "006_meal_reuse_and_supplements.sql",
        "007_ownership_lineage_integrity.sql",
        "008_supplement_create_idempotency.sql",
        "009_supplement_create_idem_reconciliation.sql",
        "010_supplement_regimen_idempotency.sql",
        "011_nutrient_expansion.sql",
    ]) {
        await client0.query(
            await Bun.file(`db/migrations/${migration}`).text(),
        );
    }
} finally {
    client0.release();
}

const server = new McpServer(
    { name: "nutrition-mcp-smoke", version: "0.0.0" },
    { capabilities: { tools: {} } },
);
registerTools(server, USER, false, null, {
    mediaStore: createMediaStore(mediaRoot),
});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "smoke-client", version: "0.0.0" });
await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
]);

const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<ToolResult>;

try {
    // Public inventory: the advertised tool set must cover the reuse and
    // supplement families and the full Release 1 head (66 tools).
    const { tools: advertised } = await client.listTools();
    const advertisedNames = new Set(advertised.map((t) => t.name));
    for (const required of [
        "search_meals",
        "reuse_meal_calculation",
        "create_supplement_product",
        "get_supplement_product",
        "list_supplement_products",
        "search_supplement_products",
        "revise_supplement_product_label",
        "create_supplement_regimen",
        "list_supplement_regimens",
        "set_supplement_regimen_active",
        "resolve_supplement_product",
        "log_supplement_intake",
        "get_supplement_intakes",
        "get_supplement_regimen_status",
        "get_supplement_nutrition_summary",
        "get_supplement_data_flags",
    ]) {
        check(
            `inventory: ${required}`,
            advertisedNames.has(required),
            required,
        );
    }
    check(
        "inventory size",
        advertisedNames.size >= 66,
        `advertised=${advertisedNames.size}`,
    );

    // log
    const logged = await call("log_meal", {
        description: "smoke oatmeal",
        meal_type: "breakfast",
        calories: 300,
        protein_g: 12,
        carbs_g: 54,
        fat_g: 6,
        logged_at: `${DAY}T08:00:00.000Z`,
        idempotency_key: `smoke-log-${RUN}`,
    });
    check(
        "log_meal",
        !logged.isError &&
            logged.structuredContent?.action === "logged" &&
            logged.structuredContent?.date === DAY &&
            logged.structuredContent?.provenance_status === "compatibility" &&
            logged.structuredContent?.event_version === 1 &&
            logged.structuredContent?.has_calculation_bundle === false &&
            logged.content[0]!.text!.includes("smoke oatmeal"),
        JSON.stringify(logged.structuredContent ?? logged.content),
    );

    // bulk import
    const bulk = await call("bulk_import_meals", {
        meals: [
            {
                source_line: 1,
                description: "smoke bulk rice",
                meal_type: "lunch",
                logged_at: `${DAY}T13:00:00.000Z`,
                calories: 450,
            },
        ],
        expected_row_count: 1,
        expected_total_kcal: 450,
        dry_run: false,
    });
    check(
        "bulk_import_meals",
        !bulk.isError &&
            (bulk.structuredContent?.summary as { created?: number })
                ?.created === 1,
        JSON.stringify(bulk.structuredContent),
    );

    // update
    const { rows } = await pool.query(
        "SELECT id FROM meal_events WHERE user_id = $1 AND idempotency_key = $2",
        [USER, `smoke-log-${RUN}`],
    );
    const mealId = rows[0]!.id as string;
    const updated = await call("update_meal", {
        id: mealId,
        calories: 350,
        notes: "smoke correction",
    });
    check(
        "update_meal",
        !updated.isError &&
            updated.structuredContent?.action === "updated" &&
            updated.content[0]!.text!.includes("350"),
        JSON.stringify(updated.structuredContent ?? updated.content),
    );

    // the eight legacy reads
    const today = await call("get_meals_today");
    check(
        "get_meals_today",
        !today.isError &&
            today.content[0]!.text!.includes("smoke oatmeal") &&
            today.content[0]!.text!.includes("smoke bulk rice"),
        today.content[0]!.text ?? "",
    );
    const byDate = await call("get_meals_by_date", { date: DAY });
    check(
        "get_meals_by_date",
        !byDate.isError &&
            byDate.content[0]!.text!.includes("smoke oatmeal") &&
            byDate.content[0]!.text!.includes("smoke bulk rice") &&
            byDate.content[0]!.text!.includes("Calories: 350"),
        byDate.content[0]!.text ?? "",
    );
    const byRange = await call("get_meals_by_date_range", {
        start_date: DAY,
        end_date: DAY,
    });
    check(
        "get_meals_by_date_range",
        !byRange.isError &&
            byRange.content[0]!.text!.includes(DAY) &&
            byRange.content[0]!.text!.includes("smoke oatmeal") &&
            byRange.content[0]!.text!.includes("smoke bulk rice"),
        byRange.content[0]!.text ?? "",
    );
    const search = await call("search_meals", {
        queries: ["smoke"],
        days: 3650,
        limit: 10,
    });
    check(
        "search_meals",
        !search.isError && search.content[0]!.text!.includes("smoke oatmeal"),
        search.content[0]!.text ?? "",
    );
    const summary = await call("get_nutrition_summary", {
        start_date: DAY,
        end_date: DAY,
    });
    check(
        "get_nutrition_summary",
        !summary.isError &&
            summary.structuredContent?.logged_days === 1 &&
            (summary.structuredContent?.days as unknown[])?.length === 1 &&
            (summary.structuredContent?.meals as unknown[])?.length === 2,
        JSON.stringify(summary.structuredContent),
    );
    const progress = await call("get_goal_progress", { date: DAY });
    check(
        "get_goal_progress",
        !progress.isError &&
            progress.structuredContent?.date === DAY &&
            progress.structuredContent?.meal_count === 2,
        JSON.stringify(progress.structuredContent),
    );
    const trends = await call("get_trends", { days: 30, end_date: DAY });
    check(
        "get_trends",
        !trends.isError &&
            trends.structuredContent?.end_date === DAY &&
            (trends.structuredContent?.days as unknown[])?.length === 30,
        JSON.stringify(trends.structuredContent),
    );
    const patterns = await call("get_meal_patterns", {
        days: 30,
        end_date: DAY,
    });
    check(
        "get_meal_patterns",
        !patterns.isError && patterns.content[0]!.text!.includes("Patterns"),
        patterns.content[0]!.text ?? "",
    );

    // export (before delete, so the file must exist)
    const exported = await call("export_meals");
    check(
        "export_meals",
        !exported.isError && exported.content[0]!.text!.includes("2 meal"),
        exported.content[0]!.text ?? "",
    );
    const csv = await Bun.file(`exports/${USER}/meals.csv`).text();
    check(
        "export csv content",
        csv.includes("smoke oatmeal") && csv.includes(",350,"),
        csv,
    );

    // delete
    const deleted = await call("delete_meal", { id: mealId });
    check("delete_meal", !deleted.isError, JSON.stringify(deleted.content));
    const afterDelete = await call("get_meals_by_date", { date: DAY });
    check(
        "read excludes deleted",
        !afterDelete.content[0]!.text!.includes("smoke oatmeal") &&
            afterDelete.content[0]!.text!.includes("smoke bulk rice"),
        afterDelete.content[0]!.text ?? "",
    );

    // capture media round trip through the public tool boundary:
    // start -> attach (tiny PNG fixture) -> draft echoing the attach identity
    // -> confirm, then re-read the persisted result.
    const started = await call("start_meal_capture", {
        conversation_key: `smoke-capture-${RUN}`,
        idempotency_key: `smoke-capture-${RUN}`,
    });
    check(
        "start_meal_capture",
        !started.isError &&
            started.structuredContent?.state === "receiving" &&
            typeof started.structuredContent?.capture_id === "string" &&
            started.structuredContent?.event_id === null &&
            started.structuredContent?.version === null,
        JSON.stringify(started.structuredContent),
    );
    const captureId = started.structuredContent!.capture_id as string;

    const attached = await call("attach_meal_capture_media", {
        capture_id: captureId,
        kind: "photo",
        mime_type: "image/png",
        bytes_base64: PNG_BASE64,
        idempotency_key: `smoke-attach-${RUN}`,
    });
    check(
        "attach_meal_capture_media",
        !attached.isError &&
            attached.structuredContent?.capture_id === captureId &&
            typeof attached.structuredContent?.media_id === "string" &&
            attached.structuredContent?.storage_key ===
                `capture/${captureId}/photo-${PNG_SHA256}` &&
            attached.structuredContent?.sha256 === PNG_SHA256 &&
            attached.structuredContent?.byte_size === PNG_BYTES.byteLength &&
            attached.structuredContent?.capture_state === "receiving" &&
            attached.structuredContent?.deduplicated === false,
        JSON.stringify(attached.structuredContent),
    );
    const media = attached.structuredContent!;
    const stagedPath = join(mediaRoot, media.storage_key as string);
    const stagedBytes = new Uint8Array(
        await Bun.file(stagedPath).arrayBuffer(),
    );
    check(
        "attach staged bytes on disk",
        new Bun.CryptoHasher("sha256").update(stagedBytes).digest("hex") ===
            PNG_SHA256,
        stagedPath,
    );

    const drafted = await call("save_meal_capture_draft", {
        capture_id: captureId,
        draft: {
            reported_at: `${DAY}T12:00:00.000Z`,
            items: [{ ordinal: 0, raw_item_text: "smoke capture oats" }],
            inputs: [
                {
                    source_kind: "user_text",
                    content: "smoke capture oats with a photo",
                },
            ],
            media: [
                {
                    kind: media.kind,
                    storage_key: media.storage_key,
                    mime_type: media.mime_type,
                    byte_size: media.byte_size,
                    sha256: media.sha256,
                    metadata: media.metadata,
                },
            ],
            parser_policy_version: "hermes.v1",
            created_by: "hermes",
        },
    });
    check(
        "save_meal_capture_draft",
        !drafted.isError &&
            drafted.structuredContent?.capture_id === captureId &&
            drafted.structuredContent?.state === "ready_to_confirm",
        JSON.stringify(drafted.structuredContent),
    );

    const confirmed = await call("confirm_meal_capture", {
        capture_id: captureId,
        confirmation: "add",
        event_idempotency_key: `smoke-confirm-${RUN}`,
    });
    check(
        "confirm_meal_capture",
        !confirmed.isError &&
            confirmed.structuredContent?.capture_id === captureId &&
            confirmed.structuredContent?.state === "confirmed" &&
            typeof confirmed.structuredContent?.event_id === "string" &&
            confirmed.structuredContent?.version === 1 &&
            ["ready", "pending", "unavailable", "missing"].includes(
                confirmed.structuredContent?.provenance_status as string,
            ) &&
            typeof confirmed.structuredContent?.compatibility === "boolean",
        JSON.stringify(confirmed.structuredContent),
    );
    const confirmedEventId = confirmed.structuredContent!.event_id as string;

    // Persisted/re-read proof through public reads.
    const captureRead = await call("get_meal_capture", {
        capture_id: captureId,
    });
    const captureView = captureRead.structuredContent?.capture as
        | { state?: string; capture_id?: string; media?: unknown[] }
        | null
        | undefined;
    check(
        "get_meal_capture re-read",
        !captureRead.isError &&
            captureView?.state === "confirmed" &&
            captureView?.capture_id === captureId &&
            captureView?.media?.length === 1,
        JSON.stringify(captureRead.structuredContent),
    );
    const afterConfirm = await call("get_meals_by_date", { date: DAY });
    check(
        "get_meals_by_date shows confirmed capture",
        !afterConfirm.isError &&
            afterConfirm.content[0]!.text!.includes("smoke capture oats"),
        afterConfirm.content[0]!.text ?? "",
    );
    const { rows: eventMediaRows } = await pool.query(
        "SELECT count(*) AS n FROM meal_event_media WHERE event_id = $1 AND version = 1",
        [confirmedEventId],
    );
    check(
        "confirmed event media persisted",
        Number(eventMediaRows[0]!.n) === 1,
        JSON.stringify(eventMediaRows),
    );

    // Minimal supplement transport round trip: create a caloric
    // sports_nutrition product from a verified label, log a done intake
    // (which atomically links one label-derived snack event), re-read the
    // snack's public provenance, and read the intake fact back.
    const created = await call("create_supplement_product", {
        category: "sports_nutrition",
        display_name: "Smoke Whey",
        serving_amount: 30,
        serving_unit: "g",
        nutrients: [
            { nutrient_key: "calories", amount: 120, unit: "kcal" },
            { nutrient_key: "protein_g", amount: 21, unit: "g" },
            // Explicit numeric zero: real label data, must read back as 0.
            { nutrient_key: "fat_g", amount: 0, unit: "g" },
        ],
        label_evidence: { kind: "label_photo", verified_by: "user" },
        label_source_kind: "user_verified_label",
        idempotency_key: `smoke-product-${RUN}`,
    });
    check(
        "create_supplement_product",
        !created.isError &&
            typeof (
                created.structuredContent?.product as { product_id?: unknown }
            )?.product_id === "string",
        JSON.stringify(created.structuredContent ?? created.content),
    );
    const productId = (
        created.structuredContent!.product as { product_id: string }
    ).product_id;

    const intake = await call("log_supplement_intake", {
        product_id: productId,
        servings: 2,
        occurred_at: `${DAY}T09:00:00.000Z`,
        state_action: "done",
        idempotency_key: `smoke-intake-${RUN}`,
    });
    check(
        "log_supplement_intake (snack linkage)",
        !intake.isError &&
            typeof intake.structuredContent?.snack_event_id === "string" &&
            typeof intake.structuredContent?.snack_version === "number",
        JSON.stringify(intake.structuredContent ?? intake.content),
    );
    const snackEventId = intake.structuredContent!.snack_event_id as string;
    const snackVersion = intake.structuredContent!.snack_version as number;

    const snackProvenance = await call("get_calculation_provenance", {
        event_id: snackEventId,
        version: snackVersion,
    });
    const snackPayload = snackProvenance.structuredContent as
        | {
              compatibility?: boolean;
              bundle_fingerprint?: string | null;
              providers?: Array<{
                  provider?: string;
                  source_id?: string | null;
              }>;
          }
        | undefined;
    check(
        "snack provenance is label-derived",
        !snackProvenance.isError &&
            snackPayload?.compatibility === true &&
            snackPayload?.bundle_fingerprint === null &&
            snackPayload?.providers?.length === 1 &&
            snackPayload.providers[0]!.provider === "own" &&
            typeof snackPayload.providers[0]!.source_id === "string" &&
            snackPayload.providers[0]!.source_id!.startsWith("suppl-snack:"),
        JSON.stringify(snackProvenance.structuredContent),
    );

    const intakeHistory = await call("get_supplement_intakes", {});
    const intakeFacts = (
        intakeHistory.structuredContent as
            { intakes?: Array<{ visible_state?: string }> } | undefined
    )?.intakes;
    check(
        "get_supplement_intakes reads back done fact",
        !intakeHistory.isError &&
            Array.isArray(intakeFacts) &&
            intakeFacts.some((fact) => fact.visible_state === "done"),
        JSON.stringify(intakeHistory.structuredContent),
    );

    console.log(
        "MCP smoke: all steps passed — log_meal, bulk_import_meals, update_meal, " +
            "get_meals_today, get_meals_by_date, get_meals_by_date_range, " +
            "search_meals, get_nutrition_summary, get_goal_progress, get_trends, " +
            "get_meal_patterns, export_meals, delete_meal, start_meal_capture, " +
            "attach_meal_capture_media, save_meal_capture_draft, " +
            "confirm_meal_capture, get_meal_capture, create_supplement_product, " +
            "log_supplement_intake, get_calculation_provenance, " +
            "get_supplement_intakes.",
    );
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
} finally {
    setSystemTime();
    await flushAnalytics();
    await client.close();
    await server.close();
    await closePool();
    await pool.end();
    rmSync(exportsDir, { recursive: true, force: true });
    rmSync(mediaRoot, { recursive: true, force: true });
}
