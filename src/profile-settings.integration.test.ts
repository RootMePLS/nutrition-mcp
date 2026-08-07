import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "bun:test";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "./mcp.js";
import { upsertProfile } from "./db.js";
import { flushAnalytics } from "./analytics.js";

// ---------------------------------------------------------------------------
// Release 2 blocker regression suite: every profile-settings write must be a
// SPARSE patch. A tool that sets one field may not move any other field.
// Ground truth is the profiles ROW read back over SQL — S1 evidence
// (.hermes/plans/2026-08-07-release2-s1-evidence.md §6) proved tool readbacks
// alone cannot reveal the clobber. DB-gated: skipped loudly without
// DATABASE_URL_TEST; the db gate additionally pins DATABASE_URL to the same
// scratch database because src/db.ts builds its global pool from DATABASE_URL.
// ---------------------------------------------------------------------------

const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST;

if (!DATABASE_URL_TEST) {
    console.log(
        "src/profile-settings.integration.test.ts: SKIPPED — DATABASE_URL_TEST is not set",
    );
}

const describeDb = DATABASE_URL_TEST ? describe : describe.skip;

const USER = "u1";

interface ProfileRow {
    timezone: string;
    preferred_weight_unit: string | null;
    widgets_enabled: boolean;
    alcohol_tracking_enabled: boolean;
    preferred_drink_unit: string | null;
}

interface ToolResult {
    isError?: boolean;
    content: { type: string; text?: string }[];
}

async function withTools(
    run: (
        call: (
            name: string,
            args?: Record<string, unknown>,
        ) => Promise<ToolResult>,
    ) => Promise<void>,
): Promise<void> {
    const server = new McpServer(
        { name: "nutrition-mcp-test", version: "0.0.0" },
        { capabilities: { tools: {}, resources: {} } },
    );
    registerTools(server, USER, true, null);
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    try {
        await run(
            (name, args = {}) =>
                client.callTool({ name, arguments: args }) as Promise<ToolResult>,
        );
    } finally {
        await client.close();
        await server.close();
    }
}

describeDb("profile settings are sparse patches (requires DATABASE_URL_TEST)", () => {
    let pool: Pool;

    beforeAll(() => {
        pool = new Pool({ connectionString: DATABASE_URL_TEST, max: 1 });
    });

    afterAll(async () => {
        await pool.end();
    });

    // Drain fire-and-forget analytics writes before the next test drops the
    // schema, so no write lands on a missing tool_analytics table.
    afterEach(async () => {
        await flushAnalytics();
    });

    beforeEach(async () => {
        const client = await pool.connect();
        try {
            await client.query(
                "DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
            );
            for (const path of [
                "db/migrations/001_initial_schema.sql",
                "db/migrations/002_food_tracking.sql",
            ]) {
                await client.query(await Bun.file(path).text());
            }
        } finally {
            client.release();
        }
    });

    async function row(): Promise<ProfileRow> {
        const { rows } = await pool.query(
            `SELECT timezone, preferred_weight_unit, widgets_enabled,
                    alcohol_tracking_enabled, preferred_drink_unit
             FROM profiles WHERE user_id = $1`,
            [USER],
        );
        expect(rows.length).toBe(1);
        return rows[0] as ProfileRow;
    }

    // ------------------------------------------------------------------
    // Layer 1: upsertProfile directly (the function under repair)
    // ------------------------------------------------------------------

    describe("upsertProfile (db layer)", () => {
        test("first insert applies documented defaults for omitted fields", async () => {
            await upsertProfile(USER, { timezone: "Europe/Zurich" });
            expect(await row()).toEqual({
                timezone: "Europe/Zurich",
                preferred_weight_unit: null,
                widgets_enabled: true,
                alcohol_tracking_enabled: false,
                preferred_drink_unit: null,
            });
        });

        test("alcohol patch preserves previously set timezone (live blocker, order 1)", async () => {
            await upsertProfile(USER, { timezone: "Europe/Zurich" });
            await upsertProfile(USER, {
                alcohol_tracking_enabled: true,
                preferred_drink_unit: "uk",
            });
            expect(await row()).toEqual({
                timezone: "Europe/Zurich",
                preferred_weight_unit: null,
                widgets_enabled: true,
                alcohol_tracking_enabled: true,
                preferred_drink_unit: "uk",
            });
        });

        test("timezone patch preserves previously set alcohol fields (live blocker, order 2)", async () => {
            await upsertProfile(USER, {
                alcohol_tracking_enabled: true,
                preferred_drink_unit: "uk",
            });
            await upsertProfile(USER, { timezone: "Europe/Zurich" });
            expect(await row()).toEqual({
                timezone: "Europe/Zurich",
                preferred_weight_unit: null,
                widgets_enabled: true,
                alcohol_tracking_enabled: true,
                preferred_drink_unit: "uk",
            });
        });

        test("widgets toggle touches nothing but widgets_enabled (latent bug)", async () => {
            await upsertProfile(USER, { timezone: "Europe/Zurich" });
            await upsertProfile(USER, { preferred_weight_unit: "kg" });
            await upsertProfile(USER, {
                alcohol_tracking_enabled: true,
                preferred_drink_unit: "uk",
            });
            await upsertProfile(USER, { widgets_enabled: false });
            expect(await row()).toEqual({
                timezone: "Europe/Zurich",
                preferred_weight_unit: "kg",
                widgets_enabled: false,
                alcohol_tracking_enabled: true,
                preferred_drink_unit: "uk",
            });
        });

        test("explicit null still clears a unit; omitted null does not", async () => {
            await upsertProfile(USER, { preferred_weight_unit: "kg" });
            await upsertProfile(USER, { timezone: "Europe/Zurich" });
            expect((await row()).preferred_weight_unit).toBe("kg");
            await upsertProfile(USER, { preferred_weight_unit: null });
            expect(await row()).toEqual({
                timezone: "Europe/Zurich",
                preferred_weight_unit: null,
                widgets_enabled: true,
                alcohol_tracking_enabled: false,
                preferred_drink_unit: null,
            });
        });

        test("toggling alcohol off without drink_unit keeps the stored unit (mcp.ts:4850 intent)", async () => {
            await upsertProfile(USER, {
                alcohol_tracking_enabled: true,
                preferred_drink_unit: "uk",
            });
            await upsertProfile(USER, { alcohol_tracking_enabled: false });
            const r = await row();
            expect(r.alcohol_tracking_enabled).toBe(false);
            expect(r.preferred_drink_unit).toBe("uk");
        });
    });

    // ------------------------------------------------------------------
    // Layer 2: the public MCP tools (what the live S1 run exercised)
    // ------------------------------------------------------------------

    describe("public MCP setters (registerTools + client transport)", () => {
        test("R2-A1: set_timezone then set_alcohol_tracking — both survive, row-verified", async () => {
            await withTools(async (call) => {
                const tz = await call("set_timezone", {
                    timezone: "Europe/Zurich",
                });
                expect(tz.isError).not.toBe(true);
                const alc = await call("set_alcohol_tracking", {
                    enabled: true,
                    drink_unit: "uk",
                });
                expect(alc.isError).not.toBe(true);

                // Tool readbacks (the S1 acceptance surface)…
                const tzBack = await call("get_timezone");
                expect(tzBack.content[0]?.text).toContain("Europe/Zurich");
                const alcBack = await call("get_alcohol_tracking");
                expect(alcBack.content[0]?.text).toContain("enabled");
                expect(alcBack.content[0]?.text).toContain("UK units");

                // …AND the row, which the readbacks alone cannot vouch for.
                expect(await row()).toEqual({
                    timezone: "Europe/Zurich",
                    preferred_weight_unit: null,
                    widgets_enabled: true,
                    alcohol_tracking_enabled: true,
                    preferred_drink_unit: "uk",
                });
            });
        });

        test("R2-A1 reverse order: set_alcohol_tracking then set_timezone — both survive", async () => {
            await withTools(async (call) => {
                await call("set_alcohol_tracking", {
                    enabled: true,
                    drink_unit: "uk",
                });
                await call("set_timezone", { timezone: "Europe/Zurich" });
                expect(await row()).toEqual({
                    timezone: "Europe/Zurich",
                    preferred_weight_unit: null,
                    widgets_enabled: true,
                    alcohol_tracking_enabled: true,
                    preferred_drink_unit: "uk",
                });
            });
        });

        test("all four setters in sequence: every field lands, none is lost", async () => {
            await withTools(async (call) => {
                await call("set_timezone", { timezone: "Europe/Zurich" });
                await call("set_weight_unit", { unit: "kg" });
                await call("set_alcohol_tracking", {
                    enabled: true,
                    drink_unit: "uk",
                });
                await call("set_widget_display", { enabled: false });
                expect(await row()).toEqual({
                    timezone: "Europe/Zurich",
                    preferred_weight_unit: "kg",
                    widgets_enabled: false,
                    alcohol_tracking_enabled: true,
                    preferred_drink_unit: "uk",
                });
            });
        });

        test("backward compat: set_weight_unit(null) clears only the weight unit", async () => {
            await withTools(async (call) => {
                await call("set_timezone", { timezone: "Europe/Zurich" });
                await call("set_weight_unit", { unit: "kg" });
                await call("set_weight_unit", { unit: null });
                expect(await row()).toEqual({
                    timezone: "Europe/Zurich",
                    preferred_weight_unit: null,
                    widgets_enabled: true,
                    alcohol_tracking_enabled: false,
                    preferred_drink_unit: null,
                });
            });
        });
    });
});
