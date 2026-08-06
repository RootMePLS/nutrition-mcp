// ============================================================================
// SUPPLEMENT / SPORTS-NUTRITION DOMAIN CONTRACTS
// ============================================================================
// Pure TypeScript contracts for the versioned supplement catalogue substrate
// introduced by migration 006: product categories, generic label nutrients,
// regimen schedules, append-only intake state projection, alias normalization,
// and idempotency identity. No database, no network, no MCP registration.

import { NUTRIENT_FIELDS, sha256Hex } from "./meal-types.js";

// ---------------------------------------------------------------------------
// PRODUCT CATEGORY
// ---------------------------------------------------------------------------
// The category distinguishes an ordinary supplement from caloric sports
// nutrition; only sports nutrition may ever link intake to a snack meal event.

export type SupplementProductCategory = "supplement" | "sports_nutrition";

const SUPPLEMENT_PRODUCT_CATEGORIES: readonly string[] = [
    "supplement",
    "sports_nutrition",
];

export function isSupplementProductCategory(
    value: string,
): value is SupplementProductCategory {
    return SUPPLEMENT_PRODUCT_CATEGORIES.includes(value);
}

// ---------------------------------------------------------------------------
// LABEL NUTRIENTS (generic, immutable per product version)
// ---------------------------------------------------------------------------
// Every nutrient actually supplied by the label/source is persisted with an
// explicit unit. An unknown value is omitted entirely — never stored as a
// synthetic zero and never stored as NULL. An explicitly supplied numeric
// zero is real data and is preserved as 0.
//
// Food-compatible keys are exactly the seven canonical meal nutrient fields;
// they are the only keys eligible for later snack-event materialization and
// combined totals. Unfamiliar keys remain supplement-only facts and are never
// coerced into a meal field or a conversion guess.

export const FOOD_COMPATIBLE_NUTRIENT_KEYS = NUTRIENT_FIELDS;

export type FoodCompatibleNutrientKey = (typeof NUTRIENT_FIELDS)[number];

export interface SupplementLabelNutrientInput {
    nutrient_key: string;
    display_name?: string | null;
    amount: number;
    unit: string;
    source_evidence?: Record<string, unknown>;
}

export function isFoodCompatibleNutrientKey(
    key: string,
): key is FoodCompatibleNutrientKey {
    return (NUTRIENT_FIELDS as readonly string[]).includes(key);
}

// Nutrient identity within one label version is (nutrient_key, unit): the
// same key in a different unit is a distinct, separately stored fact.
export function validateLabelNutrients(nutrients: unknown): string[] {
    const errors: string[] = [];
    if (!Array.isArray(nutrients)) {
        return ["label nutrients must be an array"];
    }
    const identities = new Set<string>();
    let duplicateSeen = false;
    for (const entry of nutrients as SupplementLabelNutrientInput[]) {
        if (entry === null || typeof entry !== "object") {
            errors.push("each label nutrient must be an object");
            continue;
        }
        if (
            typeof entry.nutrient_key !== "string" ||
            entry.nutrient_key.trim() === ""
        ) {
            errors.push("nutrient_key must be a non-empty string");
        }
        if (typeof entry.unit !== "string" || entry.unit.trim() === "") {
            errors.push("nutrient unit must be a non-empty string");
        }
        // null/undefined amounts are rejected: unknown nutrients must be
        // omitted from the list, never stored as NULL or synthetic zero.
        if (
            typeof entry.amount !== "number" ||
            !Number.isFinite(entry.amount) ||
            entry.amount < 0
        ) {
            errors.push("nutrient amount must be a finite non-negative number");
        }
        if (
            typeof entry.nutrient_key === "string" &&
            typeof entry.unit === "string"
        ) {
            const identity = `${entry.nutrient_key.trim()}${entry.unit.trim()}`;
            if (identities.has(identity) && !duplicateSeen) {
                errors.push(
                    "duplicate nutrient identity (nutrient_key + unit) within one label",
                );
                duplicateSeen = true;
            }
            identities.add(identity);
        }
    }
    return errors;
}

// ---------------------------------------------------------------------------
// REGIMEN SCHEDULE (declarative only — never scheduled or auto-marked)
// ---------------------------------------------------------------------------
// A schedule describes intent; nothing in this repository materializes jobs,
// sends reminders, or writes intake facts from it.

export type RegimenFrequency = "daily" | "weekly";

export interface RegimenSchedule {
    /** IANA timezone name, e.g. "Europe/London". */
    timezone: string;
    frequency: RegimenFrequency;
    /** Local wall time in 24h "HH:MM" form. */
    local_time: string;
    /** ISO 8601 weekday numbers (1 = Monday … 7 = Sunday); weekly only. */
    weekdays?: number[] | null;
}

const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function isValidIanaTimezone(value: unknown): value is string {
    if (typeof value !== "string" || value.trim() === "") return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

export function validateRegimenSchedule(schedule: unknown): string[] {
    const errors: string[] = [];
    if (schedule === null || typeof schedule !== "object") {
        return ["schedule must be an object"];
    }
    const s = schedule as RegimenSchedule;
    if (!isValidIanaTimezone(s.timezone)) {
        errors.push("schedule timezone must be a valid IANA timezone name");
    }
    if (s.frequency !== "daily" && s.frequency !== "weekly") {
        errors.push("schedule frequency must be 'daily' or 'weekly'");
    }
    if (
        typeof s.local_time !== "string" ||
        !LOCAL_TIME_PATTERN.test(s.local_time)
    ) {
        errors.push("schedule local_time must be 24h 'HH:MM'");
    }
    if (s.frequency === "weekly") {
        if (!Array.isArray(s.weekdays) || s.weekdays.length === 0) {
            errors.push("weekly schedule requires a non-empty weekday list");
        } else {
            const seen = new Set<number>();
            for (const day of s.weekdays) {
                if (
                    typeof day !== "number" ||
                    !Number.isInteger(day) ||
                    day < 1 ||
                    day > 7 ||
                    seen.has(day)
                ) {
                    errors.push(
                        "weekdays must be unique ISO 8601 integers (1 = Monday … 7 = Sunday)",
                    );
                    break;
                }
                seen.add(day);
            }
        }
    } else if (
        s.frequency === "daily" &&
        Array.isArray(s.weekdays) &&
        s.weekdays.length > 0
    ) {
        errors.push("daily schedule must not carry weekdays");
    }
    return errors;
}

// ---------------------------------------------------------------------------
// INTAKE STATE (append-only facts, projected visible state)
// ---------------------------------------------------------------------------
// Facts record state actions done/missed/cleared; the user-visible projection
// is exactly undefined|done|missed. An absent mark is undefined, never missed;
// cleared returns the occurrence to undefined (cycle: undefined → done →
// missed → undefined). History retains the raw actions for audit.

export type SupplementIntakeStateAction = "done" | "missed" | "cleared";

export type SupplementIntakeVisibleState = "undefined" | "done" | "missed";

export function projectIntakeVisibleState(
    action: SupplementIntakeStateAction | null | undefined,
): SupplementIntakeVisibleState {
    if (action === "done") return "done";
    if (action === "missed") return "missed";
    return "undefined";
}

// ---------------------------------------------------------------------------
// ALIAS NORMALIZATION
// ---------------------------------------------------------------------------
// Aliases match case-insensitively per user. Normalization is trim +
// whitespace collapse + Unicode NFKC + lowercase. Empty aliases are invalid.
// Normalization never disambiguates: distinct normalized aliases stay
// distinct, and several products sharing one normalized alias stay ambiguous.

export function normalizeSupplementAlias(raw: string): string | null {
    if (typeof raw !== "string") return null;
    const normalized = raw
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
    return normalized === "" ? null : normalized;
}

// ---------------------------------------------------------------------------
// IDEMPOTENCY IDENTITY
// ---------------------------------------------------------------------------
// An idempotency key is bound to the user and the immutable semantic identity
// of the mutation. Replaying the same key with the same identity converges on
// the original readback; the same key with any differing identity field is a
// stable conflict, never a silent second write.

export interface SupplementIntakeIdempotencyIdentity {
    user_id: string;
    idempotency_key: string;
    product_id: string;
    product_version: number;
    servings: number;
    occurred_at: Date | string;
    state_action: SupplementIntakeStateAction;
}

export function deriveSupplementIntakeIdempotencyFingerprint(
    identity: SupplementIntakeIdempotencyIdentity,
): string {
    return `supplement-intake:${sha256Hex([
        identity.user_id,
        identity.idempotency_key,
        identity.product_id,
        identity.product_version,
        identity.servings,
        String(identity.occurred_at),
        identity.state_action,
    ])}`;
}
