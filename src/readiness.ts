import type { Pool } from "pg";

// Database readiness, kept distinct from process liveness (/health). The
// probe runs a real `SELECT 1` through the shared pool under a hard timeout.
// Failure output is actionable but safe: it names only the redacted
// host:port/database identity — never credentials, query strings, fragments,
// or raw driver error text (which can embed connection details).

export type DatabaseReadiness = { ok: true } | { ok: false; error: string };

export const READINESS_TIMEOUT_MS = 2000;

/**
 * Reduce a connection URL to a safe `host[:port][/database]` identity.
 * Userinfo, query string, and fragment are always dropped. Malformed or
 * missing input yields a fixed label so the raw value is never echoed back.
 */
export function redactDatabaseUrl(url: string | undefined): string {
    if (!url || !url.trim()) return "missing DATABASE_URL";
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return "invalid DATABASE_URL";
    }
    const host = parsed.hostname;
    if (!host) return "invalid DATABASE_URL";
    const port = parsed.port ? `:${parsed.port}` : "";
    const dbName = parsed.pathname.replace(/^\//, "").split("/")[0];
    return `${host}${port}${dbName ? `/${dbName}` : ""}`;
}

export interface ReadinessCheckOptions {
    /** Hard ceiling for the probe; defaults to READINESS_TIMEOUT_MS (2s). */
    timeoutMs?: number;
    /** URL used only for the redacted target label; defaults to env. */
    databaseUrl?: string;
}

/**
 * Probe the pool with a real `SELECT 1`. Returns { ok: true } only after the
 * query actually succeeds. Any failure — driver error or timeout — returns
 * { ok: false, error } where error names the redacted target and the failure
 * class, never the raw driver message. The timed-out probe promise keeps its
 * Promise.race handlers attached, so a late rejection cannot surface as an
 * unhandled rejection, and no retry loop is left running.
 */
export async function checkDatabaseReadiness(
    pool: Pool,
    options: ReadinessCheckOptions = {},
): Promise<DatabaseReadiness> {
    const timeoutMs = options.timeoutMs ?? READINESS_TIMEOUT_MS;
    // An explicitly passed databaseUrl (even undefined) wins over the env so
    // tests can simulate a missing URL in a process that has one set.
    const target = redactDatabaseUrl(
        "databaseUrl" in options
            ? options.databaseUrl
            : process.env.DATABASE_URL,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const probe: Promise<"ok"> = pool
            .query("SELECT 1")
            .then(() => "ok" as const);
        const timeout = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), timeoutMs);
        });
        const outcome = await Promise.race([probe, timeout]);
        if (outcome === "ok") return { ok: true };
        return {
            ok: false,
            error: `database not ready: probe timed out after ${timeoutMs}ms (target ${target})`,
        };
    } catch {
        return {
            ok: false,
            error: `database not ready: connection failed (target ${target})`,
        };
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
