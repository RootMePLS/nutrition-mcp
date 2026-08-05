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

const suites = [
    "src/db.integration.test.ts",
    "src/calculation-bundles.integration.test.ts",
    "src/meal-captures.integration.test.ts",
    "src/legacy-meal-tools.integration.test.ts",
];
const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DATABASE_URL_TEST: databaseUrl,
    RUN_LEGACY_MEAL_DB_TESTS: "1",
};
let passed = 0;
let failed = 0;
let skipped = 0;
let tests = 0;

for (const suite of suites) {
    console.log(`=== ${suite} ===`);
    const child = Bun.spawn(["bun", "test", suite, "--max-concurrency", "1"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;
    process.stdout.write(output);
    const pass = Number(output.match(/(\d+) pass/)?.[1] ?? 0);
    const fail = Number(output.match(/(\d+) fail/)?.[1] ?? 0);
    const skip = Number(output.match(/(\d+) skip/)?.[1] ?? 0);
    const ran = Number(output.match(/Ran (\d+) tests?/)?.[1] ?? pass + fail);
    passed += pass;
    failed += fail;
    skipped += skip;
    tests += ran;
    const exitCode = await child.exited;
    if (exitCode !== 0 || fail !== 0) {
        console.error(
            `DB gate failed in ${suite}; refusing to report an all-green result.`,
        );
        process.exit(exitCode || 1);
    }
}

console.log(
    `DB gate totals: ${passed} pass, ${failed} fail, ${skipped} skip, ${tests} tests across ${suites.length} DB suites.`,
);
