import { test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import { checkRateLimit, _resetBuckets } from "./rate-limit.js";

const T0 = new Date("2026-01-01T00:00:00Z").getTime();

// Every test drives the clock explicitly so nothing depends on wall time.
let now = T0;
function at(ms: number): void {
    now = ms;
    setSystemTime(new Date(now));
}
function advance(ms: number): void {
    at(now + ms);
}

beforeEach(() => {
    _resetBuckets();
    at(T0);
});

afterEach(() => {
    _resetBuckets();
    setSystemTime();
});

test("checkRateLimit allows 60 requests per user per minute, then blocks", () => {
    const user = "user-abc";
    for (let i = 0; i < 60; i++) {
        const result = checkRateLimit(user);
        expect(result.allowed).toBe(true);
        expect(result.limit).toBe(60);
        expect(result.remaining).toBe(59 - i);
    }

    const blocked = checkRateLimit(user);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBe(60);

    // The window slides: once the oldest entry ages out, traffic resumes.
    advance(60_000);
    expect(checkRateLimit(user).allowed).toBe(true);
});

test("rate limit is per-user and independent", () => {
    for (let i = 0; i < 60; i++) checkRateLimit("user-a");
    expect(checkRateLimit("user-a").allowed).toBe(false);
    expect(checkRateLimit("user-b").allowed).toBe(true);
});

test("_resetBuckets clears rate-limit windows", () => {
    for (let i = 0; i < 60; i++) checkRateLimit("user-1");
    expect(checkRateLimit("user-1").allowed).toBe(false);

    _resetBuckets();
    expect(checkRateLimit("user-1").allowed).toBe(true);
});
