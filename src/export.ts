import { getAllMeals, getUserTimezone, type Meal } from "./db.js";
import { formatLocalDateTime } from "./tz.js";
import { readdirSync, statSync, unlinkSync, rmdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const EXPORT_DIR = "./exports";
// A local export file is reachable for as long as the link lifetime.
const EXPORT_TTL_SECONDS = 60 * 60; // 60 minutes
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes

/**
 * Column order for the export. This list and the positional row builder in
 * `buildMealsCsv` are parallel arrays: adding a column here without adding the
 * matching `csvEscape(...)` at the same index silently shifts every later field
 * in every row. `src/export.test.ts` guards the alignment — keep it that way.
 *
 * Header names deliberately match the importer's column aliases (`protein_g`,
 * `carbs_g`, `fiber_g`, …) so an export can be re-imported without remapping.
 */
const CSV_COLUMNS = [
    "id",
    "logged_at",
    "timezone",
    "meal_type",
    "description",
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
    "alcohol_g",
    "notes",
] as const;

/** Quote a CSV field only when it contains a delimiter, quote, or newline. */
function csvEscape(value: string | number | null | undefined): string {
    if (value == null) return "";
    const str = String(value);
    if (/[\",\r\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

/**
 * Build a CSV from meals. `logged_at` is rendered in `tz` (the user's timezone,
 * or "UTC" when none is set), and the `timezone` column records which zone the
 * timestamp is expressed in so the file is self-describing.
 */
export function buildMealsCsv(meals: Meal[], tz: string): string {
    const rows = [CSV_COLUMNS.join(",")];
    for (const m of meals) {
        rows.push(
            [
                csvEscape(m.id),
                csvEscape(formatLocalDateTime(m.logged_at, tz)),
                csvEscape(tz),
                csvEscape(m.meal_type),
                csvEscape(m.description),
                csvEscape(m.calories),
                csvEscape(m.protein_g),
                csvEscape(m.carbs_g),
                csvEscape(m.fat_g),
                csvEscape(m.fiber_g),
                csvEscape(m.sugar_g),
                csvEscape(m.alcohol_g),
                csvEscape(m.notes),
            ].join(","),
        );
    }
    return rows.join("\n");
}

export interface MealsExportResult {
    count: number;
    url?: string;
}

/**
 * Generate a CSV of all the user's meals, write it to the local filesystem
 * under `./exports/${userId}/meals.csv`, and return the path so the caller can
 * construct a download URL.
 */
export async function exportMeals(userId: string): Promise<MealsExportResult> {
    const meals = await getAllMeals(userId);
    if (meals.length === 0) return { count: 0 };

    const tz = await getUserTimezone(userId);
    const csv = buildMealsCsv(meals, tz);

    // Ensure the per-user directory exists.
    const dir = join(EXPORT_DIR, userId);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    const path = join(dir, "meals.csv");
    await Bun.write(path, csv);

    return { count: meals.length, url: `/exports/${userId}/meals.csv` };
}

/**
 * Delete export files older than EXPORT_TTL_SECONDS. Runs as a background
 * sweep so no export file outlives its link by more than one sweep interval,
 * even across server restarts and for users who never export again.
 */
export function sweepStaleExports(): void {
    const cutoff = Date.now() - EXPORT_TTL_SECONDS * 1000;

    if (!existsSync(EXPORT_DIR)) return;

    let removed = 0;
    try {
        const userDirs = readdirSync(EXPORT_DIR, { withFileTypes: true });
        for (const entry of userDirs) {
            if (!entry.isDirectory()) continue;
            const dirPath = join(EXPORT_DIR, entry.name);
            const filePath = join(dirPath, "meals.csv");

            try {
                const st = statSync(filePath);
                if (st.mtimeMs < cutoff) {
                    // Delete the file and the user directory.
                    unlinkSync(filePath);
                    try {
                        // rmdir only succeeds if the directory is empty.
                        // This is fine — we only create one file per user dir.
                        rmdirSync(dirPath);
                    } catch {
                        // Directory not empty or still in use; leave it.
                    }
                    removed++;
                }
            } catch {
                // File doesn't exist; skip.
            }
        }
    } catch (err) {
        console.warn("Export sweep: failed to scan exports dir:", (err as Error).message);
        return;
    }

    if (removed > 0) {
        console.log(`Export sweep: removed ${removed} stale file(s).`);
    }
}

let sweepRunning = false;

/** Start the periodic export-cleanup sweep. Call once at server startup. */
export function startExportCleanup(): void {
    setInterval(() => {
        if (sweepRunning) return;
        sweepRunning = true;
        try {
            sweepStaleExports();
        } finally {
            sweepRunning = false;
        }
    }, SWEEP_INTERVAL_MS);
}
