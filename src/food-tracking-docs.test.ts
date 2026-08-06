import { expect, test } from "bun:test";

const docs = await Bun.file("docs/food-tracking-agent-driven.md").text();

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
    const migrations = [
        "001_initial_schema.sql",
        "002_food_tracking.sql",
        "003_meal_captures.sql",
        "004_calculation_bundles.sql",
        "005_calculation_corrections.sql",
        "006_meal_reuse_and_supplements.sql",
    ];
    for (const migration of migrations) {
        expect(docs).toContain(migration);
        expect(
            (await Bun.file(`db/migrations/${migration}`).text()).trim(),
        ).not.toBe("");
    }
});

test("docs do not promise provider or transport work owned by Hermes", () => {
    expect(docs).not.toMatch(
        /this server (downloads|runs|calls) (Telegram|STT|OCR|vision|external MCP)/i,
    );
    expect(docs).not.toMatch(/pending[^.\n]*synced/i);
    expect(docs).not.toContain("Telegram bot is implemented");
});
