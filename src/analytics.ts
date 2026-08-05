import { getPool } from "./db.js";

interface AnalyticsRecord {
    user_id: string;
    tool_name: string;
    success: boolean;
    duration_ms: number;
    error_category?: string;
    date_range_days?: number;
    mcp_session_id?: string;
    invoked_at: string;
}

interface AnalyticsContext {
    userId: string;
    sessionId?: string;
}

function categorizeError(error: unknown): string {
    const msg =
        error instanceof Error ? error.message.toLowerCase() : String(error);

    if (
        msg.includes("auth") ||
        msg.includes("token") ||
        msg.includes("expired")
    )
        return "auth_expired";
    if (msg.includes("rate") || msg.includes("limit") || msg.includes("429"))
        return "rate_limited";
    if (msg.includes("date") || msg.includes("format"))
        return "invalid_date_format";
    if (msg.includes("required") || msg.includes("missing"))
        return "missing_required_param";
    if (
        msg.includes("database") ||
        msg.includes("failed to insert") ||
        msg.includes("failed to get") ||
        msg.includes("failed to delete") ||
        msg.includes("failed to update") ||
        msg.includes("failed to search")
    )
        return "database_error";
    if (
        msg.includes("network") ||
        msg.includes("fetch") ||
        msg.includes("ECONNREFUSED")
    )
        return "network_error";

    return "unknown";
}

function calculateDateRangeDays(
    startDate?: string,
    endDate?: string,
): number | undefined {
    if (!startDate) return undefined;

    const start = new Date(startDate);
    if (isNaN(start.getTime())) return undefined;

    if (!endDate) return 0; // single date

    const end = new Date(endDate);
    if (isNaN(end.getTime())) return undefined;

    return Math.round(
        Math.abs(end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
    );
}

// Fire-and-forget writes in flight. Tracked so tests can drain them before
// resetting the schema — otherwise a write issued at the end of one test can
// land after the next test's DROP SCHEMA and warn about a missing table.
const pendingWrites = new Set<Promise<void>>();

/** Test hook: wait until every queued analytics write has settled. */
export async function flushAnalytics(): Promise<void> {
    while (pendingWrites.size > 0) {
        await Promise.allSettled([...pendingWrites]);
    }
}

function persistAnalytics(record: AnalyticsRecord): void {
    const write = getPool()
        .query(
            `INSERT INTO tool_analytics
                (user_id, tool_name, success, duration_ms, error_category,
                 date_range_days, mcp_session_id, invoked_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                record.user_id,
                record.tool_name,
                record.success,
                record.duration_ms,
                record.error_category ?? null,
                record.date_range_days ?? null,
                record.mcp_session_id ?? null,
                record.invoked_at,
            ],
        )
        .then(
            () => undefined,
            (error: unknown) => {
                console.warn(
                    `Failed to persist analytics for ${record.tool_name}:`,
                    (error as Error).message,
                );
            },
        );
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
}

/**
 * Wrap a tool handler with timing + analytics.
 *
 * A handler that returns normally counts as a success. Tools that report failure
 * in their own payload instead of throwing (bulk_import_meals returns a
 * structured report rather than an error, so hosts don't drop the per-row
 * detail) must pass `options.outcome`, or their failures show up as successes in
 * tool_analytics.
 */
export async function withAnalytics<T>(
    toolName: string,
    handler: () => Promise<T>,
    context: AnalyticsContext,
    args?: Record<string, unknown>,
    options?: {
        outcome?: (result: T) => { success: boolean; errorCategory?: string };
    },
): Promise<T> {
    const start = performance.now();
    const invokedAt = new Date().toISOString();
    const dateRangeDays = calculateDateRangeDays(
        args?.start_date as string | undefined,
        args?.end_date as string | undefined,
    );

    try {
        const result = await handler();
        const durationMs = Math.round(performance.now() - start);
        const outcome = options?.outcome?.(result) ?? { success: true };

        if (outcome.success) {
            console.log(
                `[analytics] ${toolName} success ${durationMs}ms user=${context.userId}`,
            );
        } else {
            console.warn(
                `[analytics] ${toolName} reported-failure=${outcome.errorCategory ?? "unknown"} ${durationMs}ms user=${context.userId}`,
            );
        }

        persistAnalytics({
            user_id: context.userId,
            tool_name: toolName,
            success: outcome.success,
            duration_ms: durationMs,
            error_category: outcome.success
                ? undefined
                : (outcome.errorCategory ?? "unknown"),
            date_range_days: dateRangeDays,
            mcp_session_id: context.sessionId,
            invoked_at: invokedAt,
        });

        return result;
    } catch (error) {
        const durationMs = Math.round(performance.now() - start);
        const errorCategory = categorizeError(error);

        console.warn(
            `[analytics] ${toolName} error=${errorCategory} ${durationMs}ms user=${context.userId}`,
        );

        persistAnalytics({
            user_id: context.userId,
            tool_name: toolName,
            success: false,
            duration_ms: durationMs,
            error_category: errorCategory,
            date_range_days: dateRangeDays,
            mcp_session_id: context.sessionId,
            invoked_at: invokedAt,
        });

        return {
            content: [
                {
                    type: "text",
                    text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        } as T;
    }
}
