import { describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import { checkDatabaseReadiness, redactDatabaseUrl } from "./readiness.js";

// Unit tests for the readiness probe. No database is touched: the pool is a
// stub whose query resolves, rejects, or hangs. The probe must never surface
// raw driver error text (which can embed connection details) and must never
// leak credentials from DATABASE_URL into any output.

function stubPool(query: Pool["query"]): Pool {
    return { query } as unknown as Pool;
}

describe("redactDatabaseUrl", () => {
    test("strips username and password from a password-bearing URL", () => {
        const out = redactDatabaseUrl(
            "postgres://tracker:s3cr3tP%40ss@db.internal:5433/nutrition",
        );
        expect(out).toBe("db.internal:5433/nutrition");
        expect(out).not.toContain("tracker");
        expect(out).not.toContain("s3cr3t");
        expect(out).not.toContain("%40");
    });

    test("never surfaces percent-encoded credentials, decoded or raw", () => {
        const out = redactDatabaseUrl(
            "postgres://user%40corp:p%40ss%3Aw0rd@example.com:5432/appdb",
        );
        expect(out).toBe("example.com:5432/appdb");
        expect(out).not.toContain("user");
        expect(out).not.toContain("corp");
        expect(out).not.toContain("w0rd");
        expect(out).not.toContain("p%40ss");
        expect(out).not.toContain("%3A");
    });

    test("drops query string and fragment", () => {
        const out = redactDatabaseUrl(
            "postgres://u:pw@db.example.com:5432/appdb?sslmode=require&connect_timeout=5#secret-frag",
        );
        expect(out).toBe("db.example.com:5432/appdb");
        expect(out).not.toContain("sslmode");
        expect(out).not.toContain("connect_timeout");
        expect(out).not.toContain("secret-frag");
        expect(out).not.toContain("pw");
    });

    test("keeps host-only identity when port and database are absent", () => {
        expect(redactDatabaseUrl("postgres://u:pw@db.example.com")).toBe(
            "db.example.com",
        );
    });

    test("keeps host and database when port is absent", () => {
        expect(redactDatabaseUrl("postgres://db.example.com/nutrition")).toBe(
            "db.example.com/nutrition",
        );
    });

    test("labels malformed URLs as invalid without echoing input", () => {
        expect(redactDatabaseUrl("not-a-url")).toBe("invalid DATABASE_URL");
        expect(redactDatabaseUrl("postgres://:5432/db")).toBe(
            "invalid DATABASE_URL",
        );
        expect(redactDatabaseUrl("://garbage")).toBe("invalid DATABASE_URL");
    });

    test("labels missing values as missing", () => {
        expect(redactDatabaseUrl(undefined)).toBe("missing DATABASE_URL");
        expect(redactDatabaseUrl("")).toBe("missing DATABASE_URL");
        expect(redactDatabaseUrl("   ")).toBe("missing DATABASE_URL");
    });

    test("no fixture output contains its own credentials", () => {
        const fixtures: Array<{ url: string; secrets: string[] }> = [
            {
                url: "postgres://alice:hunter2@db1:5432/app",
                secrets: ["alice", "hunter2"],
            },
            {
                url: "postgres://bob%40x.y:p%40ss%2Fword@db2/app?sslmode=no-verify#frag",
                secrets: ["bob", "p%40ss", "word", "no-verify", "frag"],
            },
            {
                url: "postgresql://svc:长密码@db3:6543/营养",
                secrets: ["svc", "长密码"],
            },
        ];
        for (const { url, secrets } of fixtures) {
            const out = redactDatabaseUrl(url);
            for (const secret of secrets) {
                expect(out).not.toContain(secret);
            }
            expect(out).not.toContain("@");
            expect(out).not.toContain("?");
            expect(out).not.toContain("#");
        }
    });
});

describe("checkDatabaseReadiness", () => {
    const TARGET_URL =
        "postgres://tracker:s3cr3t@db.example.com:5433/nutrition";

    test("resolves ok after a real successful SELECT 1", async () => {
        let queried = "";
        const pool = stubPool((async (text: string) => {
            queried = text;
            return { rows: [{ "?column?": 1 }] };
        }) as Pool["query"]);
        const result = await checkDatabaseReadiness(pool, {
            databaseUrl: TARGET_URL,
        });
        expect(result).toEqual({ ok: true });
        expect(queried).toBe("SELECT 1");
    });

    test("maps a query failure to a redacted, driver-free error", async () => {
        const pool = stubPool((async () => {
            throw new Error(
                "raw driver text: connect ECONNREFUSED password=s3cr3t user=tracker",
            );
        }) as Pool["query"]);
        const result = await checkDatabaseReadiness(pool, {
            databaseUrl: TARGET_URL,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain("db.example.com:5433/nutrition");
            expect(result.error).not.toContain("s3cr3t");
            expect(result.error).not.toContain("tracker");
            expect(result.error).not.toContain("ECONNREFUSED");
            expect(result.error).not.toContain("raw driver text");
        }
    });

    test("a hanging probe fails at the hard timeout, bounded", async () => {
        const pool = stubPool((() => new Promise(() => {})) as Pool["query"]);
        const started = Date.now();
        const result = await checkDatabaseReadiness(pool, {
            databaseUrl: TARGET_URL,
            timeoutMs: 50,
        });
        const elapsed = Date.now() - started;
        expect(elapsed).toBeLessThan(2000);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain("timed out after 50ms");
            expect(result.error).toContain("db.example.com:5433/nutrition");
            expect(result.error).not.toContain("s3cr3t");
        }
    });

    test("a missing DATABASE_URL is reported as a fixed label, not echoed", async () => {
        const pool = stubPool((async () => {
            throw new Error("no connection");
        }) as Pool["query"]);
        const result = await checkDatabaseReadiness(pool, {
            databaseUrl: undefined,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain("missing DATABASE_URL");
        }
    });
});
