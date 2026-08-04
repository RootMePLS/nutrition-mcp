import { describe, expect, test } from "bun:test";
import {
    validatePreparedDraft,
    type PreparedMealDraft,
} from "./meal-capture-types.js";

test("prepared drafts retain ordered items and validate timestamps", () => {
    const draft: PreparedMealDraft = {
        reported_at: "2026-08-04T12:00:00Z",
        items: [{ ordinal: 0, raw_item_text: "oatmeal" }],
        inputs: [{ source_kind: "user_text", content: "oatmeal" }],
        media: [],
        parser_policy_version: "hermes.v1",
        created_by: "hermes",
    };
    expect(validatePreparedDraft(draft)).toEqual([]);
});

test("prepared drafts reject duplicate ordinals and invalid dates", () => {
    const errors = validatePreparedDraft({
        reported_at: "not-a-date",
        items: [
            { ordinal: 0, raw_item_text: "a" },
            { ordinal: 0, raw_item_text: "b" },
        ],
        inputs: [],
        media: [],
        parser_policy_version: "v1",
        created_by: "hermes",
    });
    expect(errors).toContain("draft item ordinals must be unique");
    expect(errors).toContain("draft reported_at must be a valid timestamp");
});

describe("capture transitions", () => {
    test("confirmation accepts only explicit add phrases", async () => {
        const { isExplicitConfirmation } = await import("./meal-captures.js");
        expect(isExplicitConfirmation("добавь")).toBe(true);
        expect(isExplicitConfirmation("add")).toBe(true);
        expect(isExplicitConfirmation("looks good")).toBe(false);
    });
});
