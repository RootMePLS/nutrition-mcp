import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";

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
];

test("agent-driven food-tracking docs state the shipped boundary", () => {
    for (const phrase of requiredContractPhrases) {
        expect(docs).toContain(phrase);
    }
});

test("agent-driven docs enumerate the forward migration chain", async () => {
    expect(migrationFiles.length).toBeGreaterThanOrEqual(7);
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
