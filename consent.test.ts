// Unit tests for the consent-state helpers exposed via __testing from index.ts.
// No network, no live models, no OMP runtime required.

import { describe, expect, test } from "bun:test";
import { __testing } from "./index";

const { describeDataConsent, grantDataConsent, hasDataConsent, hasFullDataConsent, setFullDataConsent } = __testing;

// The internal ReviewScope and ExtensionState types are not exported.
// TypeScript accepts structurally compatible objects; we annotate locally for
// clarity only.
type ReviewScope = "transcript" | "diff" | "both";

// Minimal state factory — all fields are optional so the empty object satisfies.
type State = Parameters<typeof hasDataConsent>[0];
const bare: State = {};

// ---------------------------------------------------------------------------
// hasDataConsent
// ---------------------------------------------------------------------------

describe("hasDataConsent", () => {
	// scope = "transcript"
	test("transcript scope allowed when consented=true", () => {
		expect(hasDataConsent({ consented: true }, "transcript", "")).toBe(true);
	});

	test("transcript scope allowed when dataConsent.transcript=true", () => {
		expect(hasDataConsent({ dataConsent: { transcript: true } }, "transcript", "")).toBe(true);
	});

	test("transcript scope denied when neither flag is set", () => {
		expect(hasDataConsent(bare, "transcript", "")).toBe(false);
		expect(hasDataConsent({ consented: false }, "transcript", "")).toBe(false);
	});

	// scope = "diff"
	test("diff scope with empty diff needs no consent", () => {
		expect(hasDataConsent(bare, "diff", "")).toBe(true);
		expect(hasDataConsent(bare, "diff", "   ")).toBe(true);
	});

	test("diff scope with non-empty diff requires diff consent", () => {
		expect(hasDataConsent(bare, "diff", "some diff text")).toBe(false);
	});

	test("diff scope with non-empty diff allowed when dataConsent.diff=true", () => {
		expect(hasDataConsent({ dataConsent: { diff: true } }, "diff", "some diff text")).toBe(true);
	});

	// scope = "both"
	test("both scope with empty diff only needs transcript consent", () => {
		expect(hasDataConsent({ consented: true }, "both", "")).toBe(true);
	});

	test("both scope with non-empty diff requires transcript + diff consent", () => {
		const diffText = "some diff";
		expect(hasDataConsent(bare, "both", diffText)).toBe(false);
		expect(hasDataConsent({ consented: true }, "both", diffText)).toBe(false); // missing diff
		expect(hasDataConsent({ dataConsent: { diff: true } }, "both", diffText)).toBe(false); // missing transcript
	});

	test("both scope with non-empty diff allowed when both consented", () => {
		expect(
			hasDataConsent({ consented: true, dataConsent: { transcript: true, diff: true } }, "both", "diff"),
		).toBe(true);
		expect(hasDataConsent({ dataConsent: { transcript: true, diff: true } }, "both", "diff")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// grantDataConsent
// ---------------------------------------------------------------------------

describe("grantDataConsent", () => {
	test("transcript scope grants transcript flag", () => {
		const next = grantDataConsent(bare, "transcript", "");
		expect(next.dataConsent?.transcript).toBe(true);
	});

	test("transcript scope also sets top-level consented", () => {
		const next = grantDataConsent(bare, "transcript", "");
		expect(next.consented).toBe(true);
	});

	test("diff scope with non-empty diff grants diff flag", () => {
		const next = grantDataConsent(bare, "diff", "some diff");
		expect(next.dataConsent?.diff).toBe(true);
	});

	test("diff scope with empty diff does not grant diff flag", () => {
		const next = grantDataConsent(bare, "diff", "");
		// needsDiffConsent("diff", "") is false → no diff consent set
		expect(next.dataConsent?.diff).toBeUndefined();
	});

	test("both scope with non-empty diff grants transcript and diff", () => {
		const next = grantDataConsent(bare, "both", "some diff");
		expect(next.dataConsent?.transcript).toBe(true);
		expect(next.dataConsent?.diff).toBe(true);
	});

	test("both scope with empty diff grants only transcript", () => {
		const next = grantDataConsent(bare, "both", "");
		expect(next.dataConsent?.transcript).toBe(true);
		expect(next.dataConsent?.diff).toBeUndefined();
	});

	test("preserves existing state fields", () => {
		const state = { reviewer: "gpt-4o" } as State;
		const next = grantDataConsent(state, "transcript", "");
		expect((next as Record<string, unknown>).reviewer).toBe("gpt-4o");
	});

	test("does not mutate the original state", () => {
		const state: State = { dataConsent: { transcript: false } };
		grantDataConsent(state, "transcript", "");
		expect(state.dataConsent?.transcript).toBe(false);
	});

	test("merges with pre-existing dataConsent flags", () => {
		const state: State = { dataConsent: { diff: true } };
		const next = grantDataConsent(state, "transcript", "");
		expect(next.dataConsent?.diff).toBe(true); // preserved
		expect(next.dataConsent?.transcript).toBe(true); // newly granted
	});
});

// ---------------------------------------------------------------------------
// hasFullDataConsent
// ---------------------------------------------------------------------------

describe("hasFullDataConsent", () => {
	test("returns true when consented=true and dataConsent.diff=true", () => {
		expect(hasFullDataConsent({ consented: true, dataConsent: { diff: true } })).toBe(true);
	});

	test("returns true when dataConsent.transcript=true and dataConsent.diff=true", () => {
		expect(hasFullDataConsent({ dataConsent: { transcript: true, diff: true } })).toBe(true);
	});

	test("returns false when only transcript is consented (consented=true, no diff)", () => {
		expect(hasFullDataConsent({ consented: true })).toBe(false);
	});

	test("returns false when only dataConsent.transcript is set", () => {
		expect(hasFullDataConsent({ dataConsent: { transcript: true } })).toBe(false);
	});

	test("returns false when only diff is consented", () => {
		expect(hasFullDataConsent({ dataConsent: { diff: true } })).toBe(false);
	});

	test("returns false for empty state", () => {
		expect(hasFullDataConsent(bare)).toBe(false);
	});

	test("is consistent with the result of setFullDataConsent(true)", () => {
		const next = setFullDataConsent(bare, true);
		expect(hasFullDataConsent(next)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// setFullDataConsent
// ---------------------------------------------------------------------------

describe("setFullDataConsent", () => {
	test("granted=true sets consented and both dataConsent flags", () => {
		const next = setFullDataConsent(bare, true);
		expect(next.consented).toBe(true);
		expect(next.dataConsent?.transcript).toBe(true);
		expect(next.dataConsent?.diff).toBe(true);
	});

	test("granted=false clears all consent flags", () => {
		const full = setFullDataConsent(bare, true);
		const cleared = setFullDataConsent(full, false);
		expect(cleared.consented).toBe(false);
		expect(cleared.dataConsent?.transcript).toBe(false);
		expect(cleared.dataConsent?.diff).toBe(false);
	});

	test("does not mutate the original state", () => {
		const state: State = { consented: false };
		setFullDataConsent(state, true);
		expect(state.consented).toBe(false);
	});

	test("preserves unrelated state fields", () => {
		const state = { reviewer: "o3" } as State;
		const next = setFullDataConsent(state, true);
		expect((next as Record<string, unknown>).reviewer).toBe("o3");
	});
});

// ---------------------------------------------------------------------------
// describeDataConsent
// ---------------------------------------------------------------------------

describe("describeDataConsent", () => {
	test("no consent → 'not granted'", () => {
		expect(describeDataConsent(bare)).toBe("not granted");
		expect(describeDataConsent({ consented: false })).toBe("not granted");
		expect(describeDataConsent({ dataConsent: {} })).toBe("not granted");
	});

	test("transcript only via consented=true → 'granted for transcript only'", () => {
		expect(describeDataConsent({ consented: true })).toBe("granted for transcript only");
	});

	test("transcript only via dataConsent.transcript=true → 'granted for transcript only'", () => {
		expect(describeDataConsent({ dataConsent: { transcript: true } })).toBe("granted for transcript only");
	});

	test("diff only → 'granted for diff only'", () => {
		expect(describeDataConsent({ dataConsent: { diff: true } })).toBe("granted for diff only");
	});

	test("transcript + diff via consented + dataConsent.diff → 'granted for transcript + diff'", () => {
		expect(describeDataConsent({ consented: true, dataConsent: { diff: true } })).toBe(
			"granted for transcript + diff",
		);
	});

	test("transcript + diff via dataConsent both → 'granted for transcript + diff'", () => {
		expect(describeDataConsent({ dataConsent: { transcript: true, diff: true } })).toBe(
			"granted for transcript + diff",
		);
	});

	test("output is deterministic across repeated calls with same input", () => {
		const state: State = { consented: true, dataConsent: { diff: true } };
		expect(describeDataConsent(state)).toBe(describeDataConsent(state));
	});
});
