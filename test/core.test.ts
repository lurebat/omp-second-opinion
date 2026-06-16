import { describe, expect, test } from "bun:test";
import {
	clampThinking,
	formatModel,
	hashMaterial,
	hasFinalVerdictLine,
	modelFamily,
	mostSevereVerdict,
	orderCandidates,
	parseReviewMeta,
	parseSelectorEffort,
	parseVerdict,
	resolveSelector,
	scanAndRedactMaterial,
	summarizePanel,
} from "../core";
import type { ModelLike } from "../types";

const models: ModelLike[] = [
	{ provider: "github-copilot", id: "gpt-5.5-1m", name: "GPT" },
	{ provider: "github-copilot", id: "claude-opus-4.8-1m", name: "Claude" },
	{ provider: "google", id: "gemini-3-pro-preview", name: "Gemini" },
];

describe("verdict parsing", () => {
	test("prefers ReviewMeta over prose and final line", () => {
		const text = [
			"The prior review said FLAWED, but that was quoted.",
			"Verdict: SOUND_WITH_CAVEATS",
			'ReviewMeta: {"verdict":"SOUND","blockingIssues":0,"caveats":0,"confidence":92}',
		].join("\n");
		expect(parseVerdict(text)).toBe("SOUND");
		expect(parseReviewMeta(text)).toEqual({ verdict: "SOUND", blockingIssues: 0, caveats: 0, confidence: 92 });
		expect(hasFinalVerdictLine(text)).toBe(true);
	});

	test("falls back to final verdict line then severity scan", () => {
		expect(parseVerdict("Looks okay\nVerdict: SOUND_WITH_CAVEATS")).toBe("SOUND_WITH_CAVEATS");
		expect(parseVerdict("This is flawed despite sounding okay")).toBe("FLAWED");
	});
});

describe("panel and reviewer helpers", () => {
	test("aggregates most severe verdict and summarizes split", () => {
		expect(mostSevereVerdict(["SOUND", "FLAWED", "SOUND_WITH_CAVEATS"])).toBe("FLAWED");
		expect(summarizePanel([
			{ reviewer: "a", verdict: "SOUND" },
			{ reviewer: "b", verdict: "FLAWED" },
			{ reviewer: "c", error: "timeout" },
		])).toBe("split (SOUND: 1, FLAWED: 1); 1 reviewer(s) failed");
	});

	test("orders cross-family candidates before same-family fallback", () => {
		const ordered = orderCandidates({
			available: models,
			sessionModel: models[0],
			sessionFamily: "gpt",
			familyOf: m => modelFamily(m, m.id),
			configured: undefined,
			slow: models[2],
		});
		expect(ordered.map(formatModel)).toEqual([
			"google/gemini-3-pro-preview",
			"github-copilot/claude-opus-4.8-1m",
		]);
	});

	test("resolves selectors and effort suffixes", () => {
		expect(resolveSelector("github-copilot/claude:xhigh", models)?.id).toBe("claude-opus-4.8-1m");
		expect(parseSelectorEffort("github-copilot/claude:xhigh")).toBe("xhigh");
		expect(clampThinking({ provider: "p", id: "m", thinking: { efforts: ["low", "high"] } }, "xhigh")).toBe("high");
	});
});

describe("privacy and staleness helpers", () => {
	test("redacts medium secrets and blocks high-confidence secrets", () => {
		const material = "password=reallysecure123 https://x/?sig=secret ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234";
		const blocked = scanAndRedactMaterial(material, false);
		expect(blocked.blocked).toBe(true);
		expect(blocked.text).not.toContain("reallysecure123");
		expect(blocked.text).toContain("sig=secret");
		expect(blocked.findings.map(f => f.kind)).toContain("sas-signature");
		const allowed = scanAndRedactMaterial(material, true);
		expect(allowed.blocked).toBe(false);
	});

	test("hash changes with material", () => {
		expect(hashMaterial(["a", "b"])).toBe(hashMaterial(["a", "b"]));
		expect(hashMaterial(["a", "b"])).not.toBe(hashMaterial(["a", "c"]));
	});
});
