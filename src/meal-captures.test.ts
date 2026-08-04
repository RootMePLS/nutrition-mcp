import { describe, expect, test } from "bun:test";
import {
    normalizePreparedEvidence,
    validateCaptureMedia,
    validateCaptureMessage,
    validatePreparedDraft,
    type PreparedMealDraft,
} from "./meal-capture-types.js";

const validMedia = {
    kind: "photo" as const,
    storage_key: "capture/photo.jpg",
    mime_type: "image/jpeg",
    byte_size: 10,
    sha256: "a".repeat(64),
};

test("prepared drafts retain ordered items and validate timestamps", () => {
    const draft: PreparedMealDraft = {
        reported_at: "2026-08-04T12:00:00Z",
        items: [{ ordinal: 0, raw_item_text: "oatmeal" }],
        inputs: [{ source_kind: "user_text", content: "oatmeal" }],
        media: [],
        parser_policy_version: "hermes.v1",
        created_by: "hermes",
    };
    expect(validatePreparedDraft(draft)).toEqual([]);
});

test("prepared drafts reject duplicate ordinals and invalid dates", () => {
    const errors = validatePreparedDraft({
        reported_at: "not-a-date",
        items: [
            { ordinal: 0, raw_item_text: "a" },
            { ordinal: 0, raw_item_text: "b" },
        ],
        inputs: [],
        media: [],
        parser_policy_version: "v1",
        created_by: "hermes",
    });
    expect(errors).toContain("draft item ordinals must be unique");
    expect(errors).toContain("draft reported_at must be a valid timestamp");
});

test("capture messages fail closed for missing ids, invalid dates, kinds, and metadata", () => {
    expect(validateCaptureMessage({ kind: "text" } as never)).toContain(
        "message external_message_id is required",
    );
    expect(
        validateCaptureMessage({
            external_message_id: "m1",
            kind: "unsupported",
            received_at: "not-a-date",
            raw_metadata: { bad: undefined },
        } as never),
    ).toEqual([
        "message kind is unsupported",
        "message received_at must be a valid timestamp",
        "message raw_metadata must be JSON metadata",
    ]);
});

test("capture and draft validators fail closed for malformed runtime payloads", () => {
    expect(validateCaptureMessage({} as never)).toEqual([
        "message external_message_id is required",
        "message kind is unsupported",
    ]);
    expect(validateCaptureMessage(null as never)).toEqual([
        "message external_message_id is required",
        "message kind is unsupported",
    ]);
    expect(validateCaptureMedia({} as never)).toEqual([
        "media kind is unsupported",
        "media storage_key is required",
        "media byte_size must be a finite non-negative integer",
        "media sha256 must be a lowercase hexadecimal SHA-256",
        "media mime_type is invalid for media kind",
    ]);
    expect(validatePreparedDraft({} as never)).toEqual([
        "draft.items must be an array",
        "draft.inputs must be an array",
        "draft.media must be an array",
        "draft reported_at must be a valid timestamp",
        "draft parser_policy_version is required",
        "draft created_by is required",
    ]);
});

test("all public validators fail closed for null, malformed, nested-null, and primitive payloads", () => {
    const probes: Array<[string, (value: unknown) => string[], unknown[]]> = [
        [
            "message",
            validateCaptureMessage as (value: unknown) => string[],
            [null, undefined, [], "bad", 42, true, { raw_metadata: null }],
        ],
        [
            "media",
            validateCaptureMedia as (value: unknown) => string[],
            [
                null,
                undefined,
                [],
                "bad",
                42,
                true,
                { content_hash: null, metadata: null },
            ],
        ],
        [
            "draft",
            validatePreparedDraft as (value: unknown) => string[],
            [
                null,
                undefined,
                [],
                "bad",
                42,
                true,
                { items: null, inputs: null, media: null },
                { items: [null], inputs: [null], media: [null] },
                {
                    items: [{ ordinal: null, raw_item_text: null }],
                    inputs: [{ content_hash: null }],
                    media: [{ metadata: null }],
                },
                { items: "bad", inputs: "bad", media: "bad" },
            ],
        ],
    ];
    for (const [name, validator, values] of probes) {
        for (const value of values) {
            let first: string[] = [];
            let second: string[] = [];
            expect(
                () => {
                    first = validator(value);
                    second = validator(value);
                },
                `${name} validator should not throw for ${String(value)}`,
            ).not.toThrow();
            expect(
                first!,
                `${name} validator should return errors`,
            ).not.toHaveLength(0);
            expect(second).toEqual(first);
        }
    }
});

test("metadata accepts shared aliases but rejects true cycles", () => {
    const shared = { label: "shared" };
    const nestedShared = { child: shared };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const nestedCyclic: Record<string, unknown> = {};
    nestedCyclic.child = nestedCyclic;

    for (const raw_metadata of [
        { a: shared, b: shared },
        { left: nestedShared, right: nestedShared },
        { left: { child: shared }, right: { child: shared } },
    ]) {
        expect(
            validateCaptureMessage({
                external_message_id: "m1",
                kind: "text",
                raw_metadata,
            } as never),
        ).toEqual([]);
    }
    for (const raw_metadata of [cyclic, { nested: nestedCyclic }]) {
        expect(
            validateCaptureMessage({
                external_message_id: "m1",
                kind: "text",
                raw_metadata,
            } as never),
        ).toEqual(["message raw_metadata must be JSON metadata"]);
    }
});

test("metadata rejects every non-JSON runtime value at any nesting depth", () => {
    const invalidValues = [
        undefined,
        () => 1,
        Symbol("bad"),
        1n,
        { nested: ["ok", { bad: undefined }] },
        { nested: { bad: () => 1 } },
        { nested: { bad: Symbol("bad") } },
        { nested: { bad: 1n } },
    ];
    for (const value of invalidValues) {
        expect(
            validateCaptureMessage({
                external_message_id: "m1",
                kind: "text",
                raw_metadata: value,
            } as never),
        ).toEqual(["message raw_metadata must be JSON metadata"]);
    }
});

test("public metadata validators fail closed for throwing Proxy traps", () => {
    const throwingMetadata = new Proxy(
        {},
        {
            getPrototypeOf() {
                throw new Error("prototype trap");
            },
        },
    );

    expect(() =>
        validateCaptureMessage({
            external_message_id: "m1",
            kind: "text",
            raw_metadata: throwingMetadata,
        } as never),
    ).not.toThrow();
    expect(
        validateCaptureMessage({
            external_message_id: "m1",
            kind: "text",
            raw_metadata: throwingMetadata,
        } as never),
    ).toEqual(["message raw_metadata must be JSON metadata"]);

    const throwingEntries = new Proxy(Object.create(null), {
        ownKeys() {
            throw new Error("ownKeys trap");
        },
    });
    expect(
        validateCaptureMedia({
            ...validMedia,
            metadata: throwingEntries,
        } as never),
    ).toEqual(["media metadata must be JSON metadata"]);
});

test("public metadata validators fail closed for revoked Proxies", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(() =>
        validateCaptureMessage({
            external_message_id: "m1",
            kind: "text",
            raw_metadata: proxy,
        } as never),
    ).not.toThrow();
    expect(
        validateCaptureMessage({
            external_message_id: "m1",
            kind: "text",
            raw_metadata: proxy,
        } as never),
    ).toEqual(["message raw_metadata must be JSON metadata"]);
});

test("validators validate identity and provenance fields and MIME syntax", () => {
    expect(
        validateCaptureMedia({
            ...validMedia,
            storage_key: 42,
            mime_type: "image/jpeg; charset=utf-8",
        } as never),
    ).toEqual([
        "media storage_key is required",
        "media mime_type is invalid for media kind",
    ]);
    expect(
        validatePreparedDraft({
            reported_at: "2026-08-04T12:00:00Z",
            items: [{ ordinal: 0, raw_item_text: "oatmeal" }],
            inputs: [
                {
                    source_kind: "user_text",
                    content: "oatmeal",
                    content_hash: 42,
                },
            ],
            media: [],
            parser_policy_version: "v1",
            created_by: 42,
        } as never),
    ).toEqual([
        "draft created_by is required",
        "evidence content_hash must be a lowercase hexadecimal SHA-256",
    ]);
});

test("capture media validates identity, kind, size, hash, mime, and metadata", () => {
    expect(validateCaptureMedia({ ...validMedia, storage_key: "" })).toContain(
        "media storage_key is required",
    );
    expect(
        validateCaptureMedia({
            ...validMedia,
            kind: "video",
            mime_type: "text/plain",
            byte_size: Number.NaN,
            sha256: "bad",
            metadata: { bad: undefined },
        } as never),
    ).toEqual([
        "media kind is unsupported",
        "media byte_size must be a finite non-negative integer",
        "media sha256 must be a lowercase hexadecimal SHA-256",
        "media mime_type is invalid for media kind",
        "media metadata must be JSON metadata",
    ]);
});

test("prepared drafts reject invalid evidence sources and content hashes", () => {
    const errors = validatePreparedDraft({
        reported_at: "2026-08-04T12:00:00Z",
        items: [{ ordinal: 0, raw_item_text: "oatmeal" }],
        inputs: [
            {
                source_kind: "telegram_guess",
                content: "oatmeal",
                content_hash: "0".repeat(64),
            },
        ],
        media: [],
        parser_policy_version: "v1",
        created_by: "hermes",
    } as never);
    expect(errors).toEqual([
        "evidence source_kind is unsupported",
        "evidence content_hash does not match content",
    ]);
});

test("prepared drafts require ids, retain all evidence, and sort deterministically", () => {
    const inputs = [
        { source_kind: "model_assumption", content: "a" },
        { source_kind: "photo_vision", content: "v" },
        { source_kind: "user_text", content: "u" },
        { source_kind: "audio_transcript", content: "t" },
        { source_kind: "photo_ocr", content: "o" },
    ];
    const normalized = normalizePreparedEvidence(inputs as never);
    expect(normalized.map((input) => input.source_kind)).toEqual([
        "user_text",
        "audio_transcript",
        "photo_ocr",
        "photo_vision",
        "model_assumption",
    ]);
    expect(normalized).toHaveLength(inputs.length);
    expect(
        validatePreparedDraft({
            reported_at: "2026-08-04T12:00:00Z",
            items: [],
            inputs: [],
            media: [],
            parser_policy_version: "",
            created_by: "",
        }),
    ).toEqual([
        "draft.items must not be empty",
        "draft parser_policy_version is required",
        "draft created_by is required",
    ]);
});

describe("capture transitions", () => {
    test("confirmation accepts only explicit add phrases", async () => {
        const { isExplicitConfirmation } = await import("./meal-captures.js");
        expect(isExplicitConfirmation("добавь")).toBe(true);
        expect(isExplicitConfirmation("add")).toBe(true);
        expect(isExplicitConfirmation("looks good")).toBe(false);
    });
});
