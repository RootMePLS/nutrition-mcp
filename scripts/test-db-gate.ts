import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL_TEST;
if (!databaseUrl) {
    console.error(
        "DB gate refused: DATABASE_URL_TEST must point at a disposable PostgreSQL database.",
    );
    process.exit(2);
}
if (process.env.DATABASE_URL !== databaseUrl) {
    console.error(
        "DB gate refused: DATABASE_URL must match DATABASE_URL_TEST so legacy destructive tests cannot target a different database.",
    );
    process.exit(2);
}

// Every destructive PostgreSQL suite, run sequentially and visibly. No suite
// may be skipped by hiding DB env vars; a suite that runs zero tests is
// treated as a hidden skip and fails the gate.
const suites = [
    "src/db.integration.test.ts",
    "src/meal-events.test.ts",
    "src/calculation-bundles.integration.test.ts",
    "src/meal-captures.integration.test.ts",
    "src/mcp-food-tracking.test.ts",
    "src/backup-policy.test.ts",
    "src/legacy-meal-tools.integration.test.ts",
    "src/calculation-acceptance.integration.test.ts",
    "src/supplements.integration.test.ts",
    "src/mcp-supplements.integration.test.ts",
];
const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DATABASE_URL_TEST: databaseUrl,
    RUN_LEGACY_MEAL_DB_TESTS: "1",
};

const migrations = [
    "db/migrations/001_initial_schema.sql",
    "db/migrations/002_food_tracking.sql",
    "db/migrations/003_meal_captures.sql",
    "db/migrations/004_calculation_bundles.sql",
    "db/migrations/005_calculation_corrections.sql",
    "db/migrations/006_meal_reuse_and_supplements.sql",
    "db/migrations/007_ownership_lineage_integrity.sql",
];

// Reset and materialize the complete schema before every child process. This
// is intentionally outside Bun's test scheduler: each destructive suite gets
// an isolated, deterministic database state and child processes never overlap.
async function resetDatabase(): Promise<void> {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
        await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
        for (const migration of migrations) {
            await client.query(await Bun.file(migration).text());
        }
    } finally {
        client.release();
        await pool.end();
    }
}

// Export tests write ./exports/<user>/meals.csv; keep the tree disposable.
const exportsDir = join(
    fileURLToPath(new URL("..", import.meta.url)),
    "exports",
);
function cleanExports(): void {
    rmSync(exportsDir, { recursive: true, force: true });
}

interface SuiteResult {
    suite: string;
    pass: number;
    fail: number;
    skip: number;
    ran: number;
    exitCode: number;
}

const results: SuiteResult[] = [];
cleanExports();
try {
    for (const suite of suites) {
        await resetDatabase();
        console.log(`=== ${suite} ===`);
        const child = Bun.spawn(
            ["bun", "test", suite, "--max-concurrency", "1"],
            {
                env,
                stdout: "pipe",
                stderr: "pipe",
            },
        );
        const [stdout, stderr] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        const output = `${stdout}\n${stderr}`;
        process.stdout.write(output);
        const pass = Number(output.match(/(\d+) pass/)?.[1] ?? 0);
        const fail = Number(output.match(/(\d+) fail/)?.[1] ?? 0);
        const skip = Number(output.match(/(\d+) skip/)?.[1] ?? 0);
        const ran = Number(
            output.match(/Ran (\d+) tests?/)?.[1] ?? pass + fail,
        );
        const exitCode = await child.exited;
        results.push({ suite, pass, fail, skip, ran, exitCode });
    }
} finally {
    cleanExports();
}

let passed = 0;
let failed = 0;
let skipped = 0;
let tests = 0;
const problems: string[] = [];
console.log("=== DB gate per-suite results ===");
for (const r of results) {
    console.log(
        `${r.suite}: ${r.pass} pass, ${r.fail} fail, ${r.skip} skip, ${r.ran} ran, exit ${r.exitCode}`,
    );
    passed += r.pass;
    failed += r.fail;
    skipped += r.skip;
    tests += r.ran;
    if (r.exitCode !== 0 || r.fail !== 0) {
        problems.push(`${r.suite} failed`);
    } else if (r.ran === 0) {
        problems.push(`${r.suite} ran zero tests (hidden skip)`);
    }
}

console.log(
    `DB gate totals: ${passed} pass, ${failed} fail, ${skipped} skip, ${tests} tests across ${suites.length} DB suites.`,
);
if (problems.length > 0) {
    console.error(
        `DB gate failed: ${problems.join("; ")}; refusing to report an all-green result.`,
    );
    process.exit(1);
}
