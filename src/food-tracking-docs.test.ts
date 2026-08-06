import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "./mcp.js";

const docs = await Bun.file("docs/food-tracking-agent-driven.md").text();
const readme = await Bun.file("README.md").text();

// Every migration file that actually exists on disk, in chain order. Docs
// tests derive the required chain from the directory so a new migration can
// never ship without README/docs truth.
const migrationFiles = readdirSync("db/migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort();

const requiredContractPhrases = [
    "Hermes (the agent host) owns",
    "nutrition-mcp owns",
    "no Telegram bot/webhook/polling, STT, OCR, vision",
    "start_meal_capture",
    "confirm_meal_capture",
    "добавь",
    "user_text > audio_transcript > photo_ocr > photo_vision > model_assumption",
    "MEDIA_ROOT",
    "nutrition-local",
    "request\nfingerprint",
    "consensus-10pct-v1",
    "failed`/`unavailable",
    "append-only",
    "pending",
    "DATABASE_URL_TEST",
    "undefined → done → missed → undefined",
    "no scheduler",
    "reuse_meal_calculation",
    "create_supplement_product",
    "revise_supplement_product_label",
    "search_supplement_products",
    "supplement_label",
    "label-compat-v1",
];

async function advertisedToolNames(): Promise<string[]> {
    const server = new McpServer(
        { name: "docs-inventory", version: "0.0.0" },
        { capabilities: { tools: {}, resources: {} } },
    );
    registerTools(server, "docs-inventory-user", true, null);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "docs-client", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();
    return tools.map((t) => t.name);
}

test("README tools table has one row for every live MCP registration", async () => {
    const names = await advertisedToolNames();
    // Release 1 head: 66 public tools. A later slice may add tools, but a
    // tool may never ship without a README inventory row.
    expect(names.length).toBeGreaterThanOrEqual(66);
    for (const name of names) {
        expect(readme).toContain(`| \`${name}\``);
    }
});

test("docs make no stale pre-slice-6/7 claims", () => {
    expect(readme).not.toContain("arrives with the sports-snack slice");
    expect(docs).not.toContain(
        "no MCP tools are registered for these tables yet",
    );
});

const releaseOneDenials = [
    "does not deliver or schedule weekly reports",
    "no cron, scheduler, or reminders",
    "no OCR or image parsing",
    "never re-runs or calls external nutrition providers",
    "ships no MyFitnessPal writer",
    "no medical, dosage, or interaction advice",
    "never marks an intake automatically",
];

test("README and docs explicitly deny unshipped scope", () => {
    for (const denial of releaseOneDenials) {
        expect(docs).toContain(denial);
    }
    for (const denial of [
        "does not deliver or schedule weekly reports",
        "no OCR or image parsing",
        "no medical, dosage, or interaction advice",
    ]) {
        expect(readme).toContain(denial);
    }
});

test("agent-driven food-tracking docs state the shipped boundary", () => {
    for (const phrase of requiredContractPhrases) {
        expect(docs).toContain(phrase);
    }
});

test("agent-driven docs enumerate the forward migration chain", async () => {
    expect(migrationFiles.length).toBeGreaterThanOrEqual(10);
    for (const migration of migrationFiles) {
        expect(docs).toContain(migration);
        expect(
            (await Bun.file(`db/migrations/${migration}`).text()).trim(),
        ).not.toBe("");
    }
});

test("README operator migration instructions cover the real migration head", () => {
    // Reviewer-terra finding 3: a clean setup following the README must apply
    // every migration that exists, through the current head — not a stale
    // 001-005 prefix. The chain is derived from the directory so this test
    // fails the moment a new migration ships without README truth.
    for (const migration of migrationFiles) {
        expect(readme).toContain(migration);
        // Each migration must appear in an actual operator command, not only
        // in prose: the psql apply line is the operator contract.
        expect(readme).toContain(`-f db/migrations/${migration}`);
    }
});

test("docs do not promise provider or transport work owned by Hermes", () => {
    expect(docs).not.toMatch(
        /this server (downloads|runs|calls) (Telegram|STT|OCR|vision|external MCP)/i,
    );
    expect(docs).not.toMatch(/pending[^.\n]*synced/i);
    expect(docs).not.toContain("Telegram bot is implemented");
});
