const env = { ...process.env };
delete env.DATABASE_URL;
delete env.DATABASE_URL_TEST;
delete env.RUN_LEGACY_MEAL_DB_TESTS;

const child = Bun.spawn(["bun", "test", "--max-concurrency", "1"], {
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
const exitCode = await child.exited;
if (exitCode !== 0) process.exit(exitCode);
const pass = Number(output.match(/(\d+) pass/)?.[1] ?? 0);
const fail = Number(output.match(/(\d+) fail/)?.[1] ?? 0);
const skip = Number(output.match(/(\d+) skip/)?.[1] ?? 0);
const ran = Number(output.match(/Ran (\d+) tests?/)?.[1] ?? pass + fail);
console.log(
    `Unit gate totals: ${pass} pass, ${fail} fail, ${skip} skip, ${ran} tests (DB suites are run by test:db).`,
);
