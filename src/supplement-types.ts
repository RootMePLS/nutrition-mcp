// ============================================================================
// SUPPLEMENT / SPORTS-NUTRITION DOMAIN CONTRACTS
// ============================================================================
// Pure TypeScript contracts for the versioned supplement catalogue substrate
// introduced by migration 006: product categories, generic label nutrients,
// regimen schedules, append-only intake state projection, alias normalization,
// and idempotency identity. No database, no network, no MCP registration.

import { NUTRIENT_FIELDS, sha256Hex } from "./meal-types.js";
import { dowInTz, shiftLocalDate, zonedHourUtc } from "./tz.js";

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
    // Collision-free tuple identity: nutrient_key maps to the set of units
    // seen for that exact key. No string concatenation or delimiter is
    // involved, so distinct pairs such as ("ab","c") and ("a","bc") can
    // never alias, matching the SQL uniqueness tuple
    // (product_id, version, nutrient_key, unit).
    const identities = new Map<string, Set<string>>();
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
            const key = entry.nutrient_key.trim();
            const unit = entry.unit.trim();
            const unitsForKey = identities.get(key) ?? new Set<string>();
            if (unitsForKey.has(unit) && !duplicateSeen) {
                errors.push(
                    "duplicate nutrient identity (nutrient_key + unit) within one label",
                );
                duplicateSeen = true;
            }
            unitsForKey.add(unit);
            identities.set(key, unitsForKey);
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

// ---------------------------------------------------------------------------
// STABLE SERIALIZATION
// ---------------------------------------------------------------------------
// Deterministic JSON (sorted object keys) so an idempotency fingerprint is
// stable across jsonb round-trips that reorder keys.

export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value) ?? "null";
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
        .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
        .join(",")}}`;
}

// ---------------------------------------------------------------------------
// REGIMEN IDEMPOTENCY IDENTITY
// ---------------------------------------------------------------------------
// Regimen create identity mirrors the intake helper: the key binds the user
// and the immutable intent (product/version/dose/schedule/window). The
// schedule is serialized with sorted keys so semantically equal schedules
// fingerprint identically regardless of object key order.

export interface SupplementRegimenIdempotencyIdentity {
    user_id: string;
    idempotency_key: string;
    product_id: string;
    product_version: number;
    dose_servings: number;
    schedule: RegimenSchedule;
    /** YYYY-MM-DD. */
    starts_on: string;
    /** YYYY-MM-DD or null for an open-ended regimen. */
    ends_on: string | null;
}

export function deriveSupplementRegimenIdempotencyFingerprint(
    identity: SupplementRegimenIdempotencyIdentity,
): string {
    return `supplement-regimen:${sha256Hex([
        identity.user_id,
        identity.idempotency_key,
        identity.product_id,
        identity.product_version,
        identity.dose_servings,
        stableStringify(identity.schedule),
        identity.starts_on,
        identity.ends_on,
    ])}`;
}

// ---------------------------------------------------------------------------
// REGIMEN OCCURRENCE DERIVATION (pure, bounded by the caller's window)
// ---------------------------------------------------------------------------
// An occurrence is one (regimen, local date) pair: the schedule says an
// intake is due at local_time on that local date in the schedule timezone.
// Nothing is materialized, scheduled, or auto-marked — this only derives
// which local dates carry an expectation inside a requested window.

export interface RegimenOccurrence {
    /** YYYY-MM-DD in schedule.timezone. */
    local_date: string;
    /** schedule.local_time. */
    local_time: string;
}

export function deriveRegimenOccurrences(
    schedule: RegimenSchedule,
    startsOn: string,
    endsOn: string | null,
    windowFrom: string,
    windowTo: string,
): RegimenOccurrence[] {
    // Effective range = [max(startsOn, windowFrom), min(endsOn ?? windowTo,
    // windowTo)]; YYYY-MM-DD strings compare lexicographically.
    const from = startsOn > windowFrom ? startsOn : windowFrom;
    const to = endsOn !== null && endsOn < windowTo ? endsOn : windowTo;
    if (from > to) return [];
    const weekdays =
        schedule.frequency === "weekly"
            ? new Set(schedule.weekdays ?? [])
            : null;
    const occurrences: RegimenOccurrence[] = [];
    for (let date = from; date <= to; date = shiftLocalDate(date, 1)) {
        if (weekdays !== null) {
            // ISO weekday of the local date in the schedule timezone. Anchor
            // at local noon so a midnight DST transition can never shift the
            // computed day.
            const noonUtc = zonedHourUtc(date, schedule.timezone, 12);
            const isoDow = ((dowInTz(noonUtc, schedule.timezone) + 6) % 7) + 1;
            if (!weekdays.has(isoDow)) continue;
        }
        occurrences.push({
            local_date: date,
            local_time: schedule.local_time,
        });
    }
    return occurrences;
}

// ---------------------------------------------------------------------------
// OCCURRENCE STATE REDUCTION (latest fact wins by append order)
// ---------------------------------------------------------------------------
// State authority is append order (created_at, id), never supersedes links:
// the links are audit metadata. The projection vocabulary stays exactly
// undefined|done|missed — cleared projects undefined.

export interface IntakeFactForProjection {
    id: string;
    regimen_id: string | null;
    occurred_at: string | Date;
    state_action: SupplementIntakeStateAction;
    created_at: string | Date;
}

function epochMs(instant: string | Date): number {
    return instant instanceof Date ? instant.getTime() : Date.parse(instant);
}

export function reduceOccurrenceState(
    facts: IntakeFactForProjection[],
): SupplementIntakeVisibleState {
    if (facts.length === 0) return "undefined";
    const ordered = [...facts].sort((a, b) => {
        const byTime = epochMs(a.created_at) - epochMs(b.created_at);
        if (byTime !== 0) return byTime;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return projectIntakeVisibleState(ordered[ordered.length - 1]!.state_action);
}
