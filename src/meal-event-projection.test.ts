import { test, expect } from "bun:test";
import { renderMealItems } from "./meal-event-projection.js";

test("renders current ordered items and joins current notes without fabricating nutrition", () => {
    expect(
        renderMealItems([
            {
                ordinal: 1,
                raw_item_text: "toast",
                normalized_name: "Whole-grain toast",
                notes: "with jam",
            },
            {
                ordinal: 0,
                raw_item_text: "coffee",
                normalized_name: null,
                notes: null,
            },
        ]),
    ).toEqual({ description: "coffee, Whole-grain toast", notes: "with jam" });
});
