import { describe, expect, test } from "bun:test";
import { __testing } from "../index";

describe("scoped data consent", () => {
	test("legacy consent remains transcript-only", () => {
		const legacy = { consented: true };
		expect(__testing.hasDataConsent(legacy, "transcript", "")).toBe(true);
		expect(__testing.hasDataConsent(legacy, "diff", "diff --git a/x b/x")).toBe(false);
		expect(__testing.hasDataConsent(legacy, "both", "diff --git a/x b/x")).toBe(false);
	});

	test("grant and revoke full scoped consent", () => {
		const granted = __testing.grantDataConsent({}, "both", "diff --git a/x b/x");
		expect(__testing.hasDataConsent(granted, "both", "diff --git a/x b/x")).toBe(true);
		expect(__testing.hasFullDataConsent(granted)).toBe(true);
		expect(__testing.describeDataConsent(granted)).toBe("granted for transcript + diff");

		const revoked = __testing.setFullDataConsent(granted, false);
		expect(__testing.hasDataConsent(revoked, "transcript", "")).toBe(false);
		expect(__testing.hasDataConsent(revoked, "diff", "diff --git a/x b/x")).toBe(false);
		expect(__testing.describeDataConsent(revoked)).toBe("not granted");
	});

	test("diff consent is not required when diff is empty", () => {
		expect(__testing.hasDataConsent({}, "diff", "")).toBe(true);
	});
});
