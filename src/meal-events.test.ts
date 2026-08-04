import { describe, expect, test } from "bun:test";
import {
    INPUT_PRECEDENCE,
    NUTRIENT_FIELDS,
    canTransitionJournalState,
    deriveCorrectionFingerprint,
    deriveCreateFingerprint,
    isNutritionProvider,
    isProviderResultStatus,
    resolveConsumedAt,
    sortInputsByPrecedence,
    validateCreateMealEventCommand,
    type CreateMealEventCommand,
    type MealEventInputEvidence,
} from "./meal-types.js";

// ---------------------------------------------------------------------------
// Contract fixtures: pure domain types and validation helpers. No database,
// no network, no Telegram/vision SDK types.
// ---------------------------------------------------------------------------

function validCommand(
    overrides: Partial<CreateMealEventCommand> = {},
): CreateMealEventCommand {
    return {
        user_id: "u1",
        idempotency_key: "create:abc",
        reported_at: "2026-08-04T12:00:00.000Z",
        items: [
            { ordinal: 0, raw_item_text: "oatmeal 80g" },
            { ordinal: 1, raw_item_text: "banana" },
        ],
        inputs: [
            { source_kind: "user_text", content: "oatmeal 80g and a banana" },
        ],
        media: [],
        provider_results: [],
        parser_policy_version: "policy-1",
        created_by: "test",
        ...overrides,
    };
}

describe("meal event domain contracts", () => {
    test("one event accepts multiple ordered positions", () => {
        const command = validCommand();
        expect(validateCreateMealEventCommand(command)).toEqual([]);
        expect(command.items.map((i) => i.ordinal)).toEqual([0, 1]);
    });

    test("explicit reported_at and consumed_at are preserved as given", () => {
        const reported = new Date("2026-08-04T12:00:00.000Z");
        const consumed = new Date("2026-08-04T08:30:00.000Z");
        expect(resolveConsumedAt(reported, consumed).toISOString()).toBe(
            consumed.toISOString(),
        );
    });

    test("omitted consumed_at resolves to the same instant as reported_at", () => {
        const reported = new Date("2026-08-04T12:00:00.000Z");
        expect(resolveConsumedAt(reported, undefined).toISOString()).toBe(
            reported.toISOString(),
        );
    });

    test("input precedence: user text beats audio, photo-derived and assumptions", () => {
        const inputs: MealEventInputEvidence[] = [
            { source_kind: "model_assumption", content: "guess" },
            { source_kind: "photo_vision", content: "vision labels" },
            { source_kind: "photo_ocr", content: "ocr text" },
            { source_kind: "user_text", content: "explicit text" },
            { source_kind: "audio_transcript", content: "transcript" },
        ];
        const sorted = sortInputsByPrecedence(inputs);
        expect(sorted.map((i) => i.source_kind)).toEqual([
            "user_text",
            "audio_transcript",
            "photo_ocr",
            "photo_vision",
            "model_assumption",
        ]);
        expect(INPUT_PRECEDENCE.user_text).toBeLessThan(
            INPUT_PRECEDENCE.audio_transcript,
        );
        expect(INPUT_PRECEDENCE.audio_transcript).toBeLessThan(
            INPUT_PRECEDENCE.photo_ocr,
        );
        expect(INPUT_PRECEDENCE.photo_ocr).toBeLessThan(
            INPUT_PRECEDENCE.photo_vision,
        );
        expect(INPUT_PRECEDENCE.photo_vision).toBeLessThan(
            INPUT_PRECEDENCE.model_assumption,
        );
    });

    test("provider namespaces are exactly nutrition-local, own, myfitnesspal", () => {
        expect(isNutritionProvider("nutrition-local")).toBe(true);
        expect(isNutritionProvider("own")).toBe(true);
        expect(isNutritionProvider("myfitnesspal")).toBe(true);
        expect(isNutritionProvider("usda")).toBe(false);
    });

    test("provider statuses distinguish failed/unavailable from numeric results", () => {
        expect(isProviderResultStatus("succeeded")).toBe(true);
        expect(isProviderResultStatus("failed")).toBe(true);
        expect(isProviderResultStatus("unavailable")).toBe(true);
        expect(isProviderResultStatus("ok")).toBe(false);
        // Nutrient fields are the seven canonical names, all nullable —
        // a missing value is NULL, never a fabricated zero.
        expect(NUTRIENT_FIELDS).toEqual([
            "calories",
            "protein_g",
            "carbs_g",
            "fat_g",
            "fiber_g",
            "sugar_g",
            "alcohol_g",
        ]);
    });

    test("journal authorization and state transitions are explicit", () => {
        expect(canTransitionJournalState("pending", "in_flight")).toBe(true);
        expect(canTransitionJournalState("in_flight", "succeeded")).toBe(true);
        expect(canTransitionJournalState("in_flight", "failed")).toBe(true);
        expect(canTransitionJournalState("failed", "in_flight")).toBe(true);
        expect(canTransitionJournalState("failed", "dead_letter")).toBe(true);
        // Never legal: pending cannot claim success; terminal states are final.
        expect(canTransitionJournalState("pending", "succeeded")).toBe(false);
        expect(canTransitionJournalState("succeeded", "failed")).toBe(false);
        expect(canTransitionJournalState("dead_letter", "in_flight")).toBe(
            false,
        );
    });

    test("correction fingerprint is distinct from the initial create fingerprint", () => {
        const create = deriveCreateFingerprint(validCommand());
        const correction = deriveCorrectionFingerprint({
            event_id: "evt-1",
            correction_idempotency_key: "corr:1",
            command: {
                event_id: "evt-1",
                correction_idempotency_key: "corr:1",
                items: validCommand().items,
                inputs: validCommand().inputs,
                media: [],
                provider_results: [],
                parser_policy_version: "policy-1",
                created_by: "test",
            },
        });
        expect(create).not.toBe(correction);
        // Stable: same input, same fingerprint.
        expect(deriveCreateFingerprint(validCommand())).toBe(create);
    });

    test("validation rejects an empty item list and duplicate ordinals", () => {
        expect(
            validateCreateMealEventCommand(validCommand({ items: [] })),
        ).toContain("items must not be empty");
        expect(
            validateCreateMealEventCommand(
                validCommand({
                    items: [
                        { ordinal: 0, raw_item_text: "a" },
                        { ordinal: 0, raw_item_text: "b" },
                    ],
                }),
            ),
        ).toContain("item ordinals must be unique");
    });
});
