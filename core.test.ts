// Unit tests for pure helpers exported from core.ts.
// No network, no live models, no OMP runtime required.

import { describe, expect, test } from "bun:test";
import {
	VERDICTS,
	buildTranscript,
	clampThinking,
	formatModel,
	hasFinalVerdictLine,
	modelFamily,
	mostSevereVerdict,
	orderCandidates,
	parseSelectorEffort,
	parseVerdict,
	renderEntry,
	resolveSelector,
	scanVerdict,
	textFromContent,
} from "./core";
import type { ModelLike, SessionEntry } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mkModel = (id: string, provider: string, extra?: Partial<ModelLike>): ModelLike => ({
	id,
	provider,
	...extra,
});

/** Simple family extractor: first alpha token of the model id. */
const simpleFamily = (m: ModelLike): string => modelFamily(m, m.id);

// Shared fixture set used across multiple suites
const CLAUDE_OPUS = mkModel("claude-opus-4", "anthropic");
const CLAUDE_SONNET = mkModel("claude-sonnet-4", "anthropic"); // used as session model
const GPT4O = mkModel("gpt-4o", "openai");
const O3 = mkModel("o3", "openai");
const GEMINI = mkModel("gemini-2.0-flash", "google");
const MISTRAL = mkModel("mistral-large", "mistral");

// ---------------------------------------------------------------------------
// VERDICTS constant
// ---------------------------------------------------------------------------

describe("VERDICTS", () => {
	test("contains exactly the three expected values", () => {
		expect(VERDICTS).toHaveLength(3);
		expect(VERDICTS).toContain("SOUND");
		expect(VERDICTS).toContain("SOUND_WITH_CAVEATS");
		expect(VERDICTS).toContain("FLAWED");
	});
});

// ---------------------------------------------------------------------------
// scanVerdict
// ---------------------------------------------------------------------------

describe("scanVerdict", () => {
	test("detects FLAWED by keyword", () => {
		expect(scanVerdict("This work is FLAWED")).toBe("FLAWED");
	});

	test("detects SOUND_WITH_CAVEATS with underscore form", () => {
		expect(scanVerdict("result: SOUND_WITH_CAVEATS")).toBe("SOUND_WITH_CAVEATS");
	});

	test("detects SOUND_WITH_CAVEATS with spaces", () => {
		expect(scanVerdict("SOUND WITH CAVEATS applies here")).toBe("SOUND_WITH_CAVEATS");
	});

	test("detects SOUND_WITH_CAVEATS with hyphens", () => {
		expect(scanVerdict("SOUND-WITH-CAVEATS")).toBe("SOUND_WITH_CAVEATS");
	});

	test("detects SOUND", () => {
		expect(scanVerdict("the code is SOUND")).toBe("SOUND");
	});

	test("FLAWED beats SOUND when both appear", () => {
		expect(scanVerdict("overall SOUND but one part is FLAWED")).toBe("FLAWED");
	});

	test("SOUND_WITH_CAVEATS beats SOUND when both appear", () => {
		expect(scanVerdict("SOUND but with SOUND WITH CAVEATS issues")).toBe("SOUND_WITH_CAVEATS");
	});

	test("is case-insensitive", () => {
		expect(scanVerdict("this is flawed")).toBe("FLAWED");
		expect(scanVerdict("sound with caveats")).toBe("SOUND_WITH_CAVEATS");
		expect(scanVerdict("the design is sound")).toBe("SOUND");
	});

	test("returns undefined when no verdict keyword present", () => {
		expect(scanVerdict("no verdict signal here")).toBeUndefined();
		expect(scanVerdict("")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// hasFinalVerdictLine
// ---------------------------------------------------------------------------

describe("hasFinalVerdictLine", () => {
	test("returns true when last non-empty line is a verdict line", () => {
		expect(hasFinalVerdictLine("Some review text.\n\nVerdict: SOUND")).toBe(true);
		expect(hasFinalVerdictLine("Verdict: FLAWED")).toBe(true);
		expect(hasFinalVerdictLine("Verdict: SOUND_WITH_CAVEATS")).toBe(true);
	});

	test("returns true for bold-wrapped verdict line", () => {
		expect(hasFinalVerdictLine("Analysis done.\n\n**Verdict: SOUND**")).toBe(true);
	});

	test("returns true with trailing period", () => {
		expect(hasFinalVerdictLine("Verdict: FLAWED.")).toBe(true);
	});

	test("returns false when verdict line is not last", () => {
		expect(hasFinalVerdictLine("Verdict: SOUND\n\nMore text after.")).toBe(false);
	});

	test("returns false for empty string", () => {
		expect(hasFinalVerdictLine("")).toBe(false);
	});

	test("returns false when last line is not a verdict line", () => {
		expect(hasFinalVerdictLine("Looks FLAWED.\n\nSee above for details.")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// parseVerdict
// ---------------------------------------------------------------------------

describe("parseVerdict", () => {
	// --- final-line path ---

	test("parses SOUND from final verdict line", () => {
		expect(parseVerdict("Some review.\n\nVerdict: SOUND")).toBe("SOUND");
	});

	test("parses FLAWED from final verdict line", () => {
		expect(parseVerdict("The design.\n\nVerdict: FLAWED")).toBe("FLAWED");
	});

	test("parses SOUND_WITH_CAVEATS from final verdict line (underscore)", () => {
		expect(parseVerdict("Verdict: SOUND_WITH_CAVEATS")).toBe("SOUND_WITH_CAVEATS");
	});

	test("normalises SOUND WITH CAVEATS (spaces) on final line", () => {
		expect(parseVerdict("Verdict: SOUND WITH CAVEATS")).toBe("SOUND_WITH_CAVEATS");
	});

	test("normalises SOUND-WITH-CAVEATS (hyphens) on final line", () => {
		expect(parseVerdict("Verdict: SOUND-WITH-CAVEATS")).toBe("SOUND_WITH_CAVEATS");
	});

	test("is case-insensitive on final verdict line", () => {
		expect(parseVerdict("verdict: sound")).toBe("SOUND");
		expect(parseVerdict("VERDICT: FLAWED")).toBe("FLAWED");
	});

	test("handles bold markers around final verdict line", () => {
		expect(parseVerdict("Review.\n\n**Verdict: SOUND**")).toBe("SOUND");
		expect(parseVerdict("**Verdict: FLAWED**")).toBe("FLAWED");
	});

	test("handles trailing period on final verdict line", () => {
		expect(parseVerdict("Verdict: SOUND.")).toBe("SOUND");
	});

	// --- scan fallback path ---

	test("falls back to scanVerdict when no final verdict line", () => {
		// Last line is not a verdict line; body contains FLAWED
		expect(parseVerdict("This work is FLAWED in several ways.\n\nSee above.")).toBe("FLAWED");
	});

	test("final verdict line takes precedence over contradicting body content", () => {
		// Body says FLAWED but final verdict line says SOUND
		expect(parseVerdict("The design looks FLAWED.\n\nVerdict: SOUND")).toBe("SOUND");
	});

	// --- edge cases ---

	test("returns undefined for empty string", () => {
		expect(parseVerdict("")).toBeUndefined();
	});

	test("returns undefined when no verdict signal at all", () => {
		expect(parseVerdict("Looks fine. No issues noted.")).toBeUndefined();
	});

	test("ignores leading/trailing whitespace around last line", () => {
		expect(parseVerdict("Some text.\n\nVerdict: SOUND   ")).toBe("SOUND");
	});
});

// ---------------------------------------------------------------------------
// mostSevereVerdict
// ---------------------------------------------------------------------------

describe("mostSevereVerdict", () => {
	test("returns undefined for empty array", () => {
		expect(mostSevereVerdict([])).toBeUndefined();
	});

	test("returns undefined when all inputs are undefined", () => {
		expect(mostSevereVerdict([undefined, undefined])).toBeUndefined();
	});

	test("returns a sole non-undefined verdict", () => {
		expect(mostSevereVerdict(["SOUND"])).toBe("SOUND");
		expect(mostSevereVerdict(["FLAWED"])).toBe("FLAWED");
		expect(mostSevereVerdict(["SOUND_WITH_CAVEATS"])).toBe("SOUND_WITH_CAVEATS");
	});

	test("FLAWED beats SOUND_WITH_CAVEATS and SOUND", () => {
		expect(mostSevereVerdict(["SOUND", "FLAWED", "SOUND_WITH_CAVEATS"])).toBe("FLAWED");
		expect(mostSevereVerdict(["SOUND", "FLAWED"])).toBe("FLAWED");
	});

	test("SOUND_WITH_CAVEATS beats SOUND", () => {
		expect(mostSevereVerdict(["SOUND", "SOUND_WITH_CAVEATS"])).toBe("SOUND_WITH_CAVEATS");
	});

	test("ignores undefined entries in mixed panel", () => {
		expect(mostSevereVerdict([undefined, "SOUND", undefined])).toBe("SOUND");
		expect(mostSevereVerdict([undefined, "SOUND_WITH_CAVEATS", "SOUND"])).toBe("SOUND_WITH_CAVEATS");
	});

	test("panel of all SOUND gives SOUND", () => {
		expect(mostSevereVerdict(["SOUND", "SOUND", "SOUND"])).toBe("SOUND");
	});
});

// ---------------------------------------------------------------------------
// modelFamily / formatModel
// ---------------------------------------------------------------------------

describe("modelFamily", () => {
	test("extracts the leading alpha token from a canonical id", () => {
		expect(modelFamily(mkModel("x", "openai"), "gpt-4o")).toBe("gpt");
		expect(modelFamily(mkModel("x", "anthropic"), "claude-opus-4-5")).toBe("claude");
		expect(modelFamily(mkModel("x", "google"), "gemini-2.0-flash")).toBe("gemini");
		expect(modelFamily(mkModel("x", "mistral"), "mistral-large")).toBe("mistral");
	});

	test("uses model.id when canonicalId is undefined", () => {
		expect(modelFamily(mkModel("claude-sonnet-4", "anthropic"), undefined)).toBe("claude");
	});

	test("falls back to provider when leading token is a single char (e.g. 'o3')", () => {
		// "o3" → leading alpha "o" is only 1 char → falls back to provider
		expect(modelFamily(mkModel("o3", "openai"), "o3")).toBe("openai");
	});

	test("falls back to provider for empty canonical id", () => {
		expect(modelFamily(mkModel("x", "myprovider"), "")).toBe("myprovider");
	});

	test("is case-folded (returns lowercase)", () => {
		expect(modelFamily(mkModel("x", "ANTHROPIC"), "Claude-3")).toBe("claude");
	});
});

describe("formatModel", () => {
	test("returns provider/id", () => {
		expect(formatModel(mkModel("gpt-4o", "openai"))).toBe("openai/gpt-4o");
		expect(formatModel(mkModel("claude-sonnet-4", "anthropic"))).toBe("anthropic/claude-sonnet-4");
	});
});

// ---------------------------------------------------------------------------
// resolveSelector
// ---------------------------------------------------------------------------

describe("resolveSelector", () => {
	const available = [
		mkModel("claude-opus-4", "anthropic", { name: "Claude Opus 4" }),
		mkModel("claude-sonnet-4", "anthropic", { name: "Claude Sonnet 4" }),
		mkModel("gpt-4o", "openai", { name: "GPT-4o" }),
		mkModel("gemini-2.0-flash", "google", { name: "Gemini 2.0 Flash" }),
	];

	// --- exact matches ---

	test("exact id match", () => {
		expect(resolveSelector("gpt-4o", available)?.id).toBe("gpt-4o");
		expect(resolveSelector("claude-opus-4", available)?.id).toBe("claude-opus-4");
	});

	test("exact provider/id match", () => {
		expect(resolveSelector("openai/gpt-4o", available)?.id).toBe("gpt-4o");
		expect(resolveSelector("anthropic/claude-opus-4", available)?.id).toBe("claude-opus-4");
	});

	// --- prefix / substring ---

	test("id prefix match", () => {
		expect(resolveSelector("claude-s", available)?.id).toBe("claude-sonnet-4");
		expect(resolveSelector("gemini", available)?.id).toBe("gemini-2.0-flash");
	});

	test("id substring match", () => {
		expect(resolveSelector("flash", available)?.id).toBe("gemini-2.0-flash");
		expect(resolveSelector("opus", available)?.id).toBe("claude-opus-4");
	});

	test("name substring match (case-insensitive)", () => {
		expect(resolveSelector("Opus", available)?.id).toBe("claude-opus-4");
		expect(resolveSelector("GPT", available)?.id).toBe("gpt-4o");
	});

	// --- effort suffix stripping ---

	test("strips :effort suffix before matching", () => {
		expect(resolveSelector("gpt-4o:high", available)?.id).toBe("gpt-4o");
		expect(resolveSelector("openai/gpt-4o:xhigh", available)?.id).toBe("gpt-4o");
		expect(resolveSelector("flash:medium", available)?.id).toBe("gemini-2.0-flash");
	});

	// --- no match ---

	test("returns undefined for empty selector", () => {
		expect(resolveSelector("", available)).toBeUndefined();
		expect(resolveSelector("   ", available)).toBeUndefined();
	});

	test("returns undefined when no model matches", () => {
		expect(resolveSelector("llama-3", available)).toBeUndefined();
	});

	// --- provider-scoped search ---

	test("unknown provider falls back to searching all models", () => {
		// No "unknown" provider models → pool = all available → id "gpt-4o" still matches
		expect(resolveSelector("unknown/gpt-4o", available)?.id).toBe("gpt-4o");
	});

	test("provider-scoped: wrong provider yields no match when id exists elsewhere", () => {
		// google pool has gemini-2.0-flash; searching "gpt-4o" id within google pool → no match
		expect(resolveSelector("google/gpt-4o", available)).toBeUndefined();
	});

	test("provider-scoped prefix match stays within provider", () => {
		// "anthropic/claude-s" → anthropic pool → prefix match on "claude-sonnet-4"
		expect(resolveSelector("anthropic/claude-s", available)?.id).toBe("claude-sonnet-4");
	});
});

// ---------------------------------------------------------------------------
// parseSelectorEffort
// ---------------------------------------------------------------------------

describe("parseSelectorEffort", () => {
	test("parses all known effort suffixes", () => {
		expect(parseSelectorEffort("model:off")).toBe("off");
		expect(parseSelectorEffort("model:minimal")).toBe("minimal");
		expect(parseSelectorEffort("model:low")).toBe("low");
		expect(parseSelectorEffort("model:medium")).toBe("medium");
		expect(parseSelectorEffort("model:high")).toBe("high");
		expect(parseSelectorEffort("model:xhigh")).toBe("xhigh");
	});

	test("maps :max alias to xhigh", () => {
		expect(parseSelectorEffort("model:max")).toBe("xhigh");
	});

	test("works on provider/id selectors", () => {
		expect(parseSelectorEffort("openai/gpt-4o:xhigh")).toBe("xhigh");
	});

	test("returns undefined when no suffix", () => {
		expect(parseSelectorEffort("openai/gpt-4o")).toBeUndefined();
		expect(parseSelectorEffort("model")).toBeUndefined();
		expect(parseSelectorEffort("")).toBeUndefined();
	});

	test("is case-insensitive", () => {
		expect(parseSelectorEffort("model:HIGH")).toBe("high");
		expect(parseSelectorEffort("model:XHIGH")).toBe("xhigh");
		expect(parseSelectorEffort("model:MAX")).toBe("xhigh");
	});
});

// ---------------------------------------------------------------------------
// orderCandidates
// ---------------------------------------------------------------------------

describe("orderCandidates", () => {
	const available = [CLAUDE_SONNET, CLAUDE_OPUS, GPT4O, GEMINI, MISTRAL];

	test("session model is excluded from results", () => {
		const result = orderCandidates({
			available,
			sessionModel: CLAUDE_SONNET,
			sessionFamily: "claude",
			familyOf: simpleFamily,
			configured: undefined,
			slow: undefined,
		});
		expect(result.map(m => m.id)).not.toContain("claude-sonnet-4");
	});

	test("no duplicates in result", () => {
		const result = orderCandidates({
			available,
			sessionModel: CLAUDE_SONNET,
			sessionFamily: "claude",
			familyOf: simpleFamily,
			configured: GPT4O,
			slow: GEMINI,
		});
		const labels = result.map(formatModel);
		expect(new Set(labels).size).toBe(labels.length);
	});

	test("configured model is first", () => {
		const result = orderCandidates({
			available,
			sessionModel: CLAUDE_SONNET,
			sessionFamily: "claude",
			familyOf: simpleFamily,
			configured: GPT4O,
			slow: undefined,
		});
		expect(result[0]?.id).toBe("gpt-4o");
	});

	test("cross-family slow model appears before same-family models", () => {
		const result = orderCandidates({
			available,
			sessionModel: CLAUDE_SONNET,
			sessionFamily: "claude",
			familyOf: simpleFamily,
			configured: undefined,
			slow: GEMINI, // gemini is cross-family
		});
		const geminiIdx = result.findIndex(m => m.id === "gemini-2.0-flash");
		const claudeOpusIdx = result.findIndex(m => m.id === "claude-opus-4");
		expect(geminiIdx).toBeGreaterThanOrEqual(0);
		expect(claudeOpusIdx).toBeGreaterThanOrEqual(0);
		expect(geminiIdx).toBeLessThan(claudeOpusIdx);
	});

	test("all non-session models appear in result eventually", () => {
		const result = orderCandidates({
			available,
			sessionModel: CLAUDE_SONNET,
			sessionFamily: "claude",
			familyOf: simpleFamily,
			configured: undefined,
			slow: undefined,
		});
		const ids = result.map(m => m.id);
		expect(ids).toContain("claude-opus-4");
		expect(ids).toContain("gpt-4o");
		expect(ids).toContain("gemini-2.0-flash");
		expect(ids).toContain("mistral-large");
	});

	test("session model undefined: all available models included", () => {
		const result = orderCandidates({
			available: [GPT4O, GEMINI],
			sessionModel: undefined,
			sessionFamily: undefined,
			familyOf: simpleFamily,
			configured: undefined,
			slow: undefined,
		});
		const ids = result.map(m => m.id);
		expect(ids).toContain("gpt-4o");
		expect(ids).toContain("gemini-2.0-flash");
	});

	test("same-family slow appears after cross-family candidates", () => {
		const claudeSlow = mkModel("claude-3-opus", "anthropic");
		const result = orderCandidates({
			available: [CLAUDE_SONNET, claudeSlow, GPT4O],
			sessionModel: CLAUDE_SONNET,
			sessionFamily: "claude",
			familyOf: simpleFamily,
			configured: undefined,
			slow: claudeSlow,
		});
		const gptIdx = result.findIndex(m => m.id === "gpt-4o");
		const claudeSlowIdx = result.findIndex(m => m.id === "claude-3-opus");
		// gpt is cross-family → appears before same-family slow
		expect(gptIdx).toBeLessThan(claudeSlowIdx);
	});

	test("empty available list returns empty array", () => {
		const result = orderCandidates({
			available: [],
			sessionModel: CLAUDE_SONNET,
			sessionFamily: "claude",
			familyOf: simpleFamily,
			configured: undefined,
			slow: undefined,
		});
		expect(result).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// clampThinking
// ---------------------------------------------------------------------------

describe("clampThinking", () => {
	const THINKING_ORDER = ["minimal", "low", "medium", "high", "xhigh"] as const;

	test("returns undefined when model.reasoning is false", () => {
		const m = mkModel("m", "p", { reasoning: false });
		expect(clampThinking(m, "high")).toBeUndefined();
		expect(clampThinking(m, "off")).toBeUndefined();
	});

	test("maps effort 'off' to 'minimal'", () => {
		const m = mkModel("m", "p"); // no thinking config
		expect(clampThinking(m, "off")).toBe("minimal");
	});

	test("returns requested level when model has no thinking config", () => {
		const m = mkModel("m", "p");
		expect(clampThinking(m, "medium")).toBe("medium");
		expect(clampThinking(m, "high")).toBe("high");
	});

	test("returns requested level when model supports it exactly", () => {
		const m = mkModel("m", "p", { thinking: { efforts: ["minimal", "medium", "high", "xhigh"] } });
		expect(clampThinking(m, "medium")).toBe("medium");
		expect(clampThinking(m, "xhigh")).toBe("xhigh");
	});

	test("clamps down to the highest supported level at or below requested", () => {
		// Supports low and high, not medium
		const m = mkModel("m", "p", { thinking: { efforts: ["low", "high"] } });
		expect(clampThinking(m, "medium")).toBe("low");
	});

	test("falls back to supported[0] when no level is at or below requested", () => {
		// Only supports high and xhigh; request is minimal (rank 0)
		const m = mkModel("m", "p", { thinking: { efforts: ["high", "xhigh"] } });
		expect(clampThinking(m, "minimal")).toBe("high");
	});

	test("returns want when supported list is empty after filtering", () => {
		const m = mkModel("m", "p", { thinking: { efforts: [] } });
		expect(clampThinking(m, "high")).toBe("high");
	});

	test("ignores unrecognised effort strings in model.thinking.efforts", () => {
		const m = mkModel("m", "p", { thinking: { efforts: ["turbo", "medium"] } });
		expect(clampThinking(m, "medium")).toBe("medium");
	});

	test("clamps xhigh correctly when all levels supported", () => {
		const m = mkModel("m", "p", { thinking: { efforts: [...THINKING_ORDER] } });
		expect(clampThinking(m, "xhigh")).toBe("xhigh");
	});
});

// ---------------------------------------------------------------------------
// textFromContent
// ---------------------------------------------------------------------------

describe("textFromContent", () => {
	test("passes string content through unchanged", () => {
		expect(textFromContent("hello world")).toBe("hello world");
	});

	test("returns empty string for non-array non-string values", () => {
		expect(textFromContent(null)).toBe("");
		expect(textFromContent(undefined)).toBe("");
		expect(textFromContent(42)).toBe("");
		expect(textFromContent({})).toBe("");
	});

	test("returns empty string for empty array", () => {
		expect(textFromContent([])).toBe("");
	});

	test("joins multiple text blocks with newlines", () => {
		const content = [
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		];
		expect(textFromContent(content)).toBe("first\nsecond");
	});

	test("converts tool call blocks to [tool call: name] markers", () => {
		expect(textFromContent([{ type: "toolCall", name: "bash" }])).toBe("[tool call: bash]");
	});

	test("drops thinking blocks", () => {
		const content = [
			{ type: "thinking", text: "internal reasoning" },
			{ type: "text", text: "result" },
		];
		expect(textFromContent(content)).toBe("result");
	});

	test("drops image blocks", () => {
		const content = [{ type: "image" }, { type: "text", text: "caption" }];
		expect(textFromContent(content)).toBe("caption");
	});

	test("skips null and non-object elements in the array", () => {
		expect(textFromContent([null, undefined, 99, { type: "text", text: "ok" }])).toBe("ok");
	});

	test("mixed tool call and text produces both parts", () => {
		const content = [
			{ type: "toolCall", name: "read" },
			{ type: "text", text: "output" },
		];
		expect(textFromContent(content)).toBe("[tool call: read]\noutput");
	});
});

// ---------------------------------------------------------------------------
// renderEntry
// ---------------------------------------------------------------------------

describe("renderEntry", () => {
	test("renders a user message", () => {
		const entry: SessionEntry = { type: "message", message: { role: "user", content: "hello" } };
		const result = renderEntry(entry);
		expect(result).not.toBeNull();
		expect(result?.role).toBe("user");
		expect(result?.text).toBe("hello");
	});

	test("renders an assistant message with content array", () => {
		const entry: SessionEntry = {
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
		};
		expect(renderEntry(entry)?.role).toBe("assistant");
		expect(renderEntry(entry)?.text).toBe("hi there");
	});

	test("renders toolResult with tool name prefix", () => {
		const entry: SessionEntry = {
			type: "message",
			message: { role: "toolResult", toolName: "bash", content: "exit 0" },
		};
		const r = renderEntry(entry);
		expect(r?.role).toBe("tool");
		expect(r?.text).toBe("[bash] exit 0");
	});

	test("uses 'tool' as fallback when toolName is absent", () => {
		const entry: SessionEntry = {
			type: "message",
			message: { role: "toolResult", content: "data" },
		};
		expect(renderEntry(entry)?.text).toMatch(/^\[tool\]/);
	});

	test("truncates toolResult content over 400 chars", () => {
		const entry: SessionEntry = {
			type: "message",
			message: { role: "toolResult", toolName: "read", content: "x".repeat(500) },
		};
		const r = renderEntry(entry);
		expect(r?.text).toContain("…[truncated]");
		// "[read] " prefix + 400 chars + marker — total well under 500
		expect(r!.text.length).toBeLessThan(450);
	});

	test("returns null for empty toolResult content", () => {
		const entry: SessionEntry = {
			type: "message",
			message: { role: "toolResult", content: "" },
		};
		expect(renderEntry(entry)).toBeNull();
	});

	test("returns null for message with only whitespace content", () => {
		const entry: SessionEntry = {
			type: "message",
			message: { role: "user", content: "   " },
		};
		expect(renderEntry(entry)).toBeNull();
	});

	test("returns null when message has no role string", () => {
		const entry: SessionEntry = { type: "message", message: { content: "hello" } };
		expect(renderEntry(entry)).toBeNull();
	});

	test("returns null when entry.message is absent", () => {
		const entry: SessionEntry = { type: "message" };
		expect(renderEntry(entry)).toBeNull();
	});

	test("renders compaction entry with token count and summary", () => {
		const entry: SessionEntry = {
			type: "compaction",
			summary: "prior context",
			tokensBefore: 1500,
		};
		const r = renderEntry(entry);
		expect(r?.role).toBe("compaction");
		expect(r?.text).toContain("1500");
		expect(r?.text).toContain("prior context");
	});

	test("returns null for compaction with empty summary", () => {
		expect(renderEntry({ type: "compaction", summary: "" })).toBeNull();
		expect(renderEntry({ type: "compaction" })).toBeNull();
	});

	test("renders branch_summary with fromId and summary", () => {
		const entry: SessionEntry = {
			type: "branch_summary",
			summary: "branch overview",
			fromId: "session-abc",
		};
		const r = renderEntry(entry);
		expect(r?.role).toBe("branch_summary");
		expect(r?.text).toContain("session-abc");
		expect(r?.text).toContain("branch overview");
	});

	test("uses '?' when branch_summary has no fromId", () => {
		const entry: SessionEntry = { type: "branch_summary", summary: "s" };
		expect(renderEntry(entry)?.text).toContain("[from ?]");
	});

	test("returns null for branch_summary with empty summary", () => {
		expect(renderEntry({ type: "branch_summary", summary: "" })).toBeNull();
	});

	test("renders custom_message with customType as note role", () => {
		const entry: SessionEntry = {
			type: "custom_message",
			customType: "status",
			content: "processing",
		};
		const r = renderEntry(entry);
		expect(r?.role).toBe("note:status");
		expect(r?.text).toBe("processing");
	});

	test("uses 'note:custom' as fallback when customType is absent", () => {
		const entry: SessionEntry = { type: "custom_message", content: "data" };
		expect(renderEntry(entry)?.role).toBe("note:custom");
	});

	test("returns null for unknown entry type", () => {
		expect(renderEntry({ type: "some_unknown_type" })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// buildTranscript
// ---------------------------------------------------------------------------

describe("buildTranscript", () => {
	const msg = (role: string, text: string): SessionEntry => ({
		type: "message",
		message: { role, content: text },
	});

	test("empty entries produce empty transcript", () => {
		const { text, count } = buildTranscript([]);
		expect(text).toBe("");
		expect(count).toBe(0);
	});

	test("renders a single user message with role header", () => {
		const { text, count } = buildTranscript([msg("user", "hello")]);
		expect(count).toBe(1);
		expect(text).toContain("## USER");
		expect(text).toContain("hello");
	});

	test("role labels are uppercased in headers", () => {
		const { text } = buildTranscript([msg("user", "q"), msg("assistant", "a")]);
		expect(text).toContain("## USER");
		expect(text).toContain("## ASSISTANT");
	});

	test("tool role maps to 'TOOL RESULT' header", () => {
		const entry: SessionEntry = {
			type: "message",
			message: { role: "toolResult", toolName: "bash", content: "ok" },
		};
		const { text } = buildTranscript([entry]);
		expect(text).toContain("## TOOL RESULT");
	});

	test("lookback limits to the N most recent rendered turns", () => {
		const entries = [msg("user", "old-1"), msg("assistant", "old-2"), msg("user", "recent")];
		const { count, text } = buildTranscript(entries, 1);
		expect(count).toBe(1);
		expect(text).toContain("recent");
		expect(text).not.toContain("old-1");
		expect(text).not.toContain("old-2");
	});

	test("lookback=2 keeps only last 2 turns", () => {
		const entries = [msg("user", "a"), msg("assistant", "b"), msg("user", "c")];
		const { count } = buildTranscript(entries, 2);
		expect(count).toBe(2);
	});

	test("lookback=0 is treated as no limit", () => {
		const entries = [msg("user", "a"), msg("user", "b")];
		const { count } = buildTranscript(entries, 0);
		expect(count).toBe(2);
	});

	test("entries that render to null are skipped in count", () => {
		const entries: SessionEntry[] = [
			{ type: "unknown_type" } as unknown as SessionEntry,
			msg("user", "visible"),
		];
		const { count } = buildTranscript(entries);
		expect(count).toBe(1);
	});

	test("single oversized entry is truncated to budget with marker", () => {
		// 60 000-char block far exceeds 48 000-char budget
		const { text } = buildTranscript([msg("user", "A".repeat(60_000))]);
		expect(text).toContain("…[truncated to transcript budget]");
		expect(text.length).toBeLessThan(60_000);
	});

	test("oldest turns are dropped when total exceeds budget", () => {
		// Two ~30 000-char blocks; only the newest fits
		const entries = [msg("user", "FIRST_" + "A".repeat(30_000)), msg("assistant", "SECOND_" + "B".repeat(30_000))];
		const { text } = buildTranscript(entries);
		expect(text).toContain("SECOND_");
		expect(text).not.toContain("FIRST_");
	});

	test("count reflects number of kept blocks, not raw entries", () => {
		const entries = Array.from({ length: 5 }, (_, i) => msg("user", `turn ${i}`));
		const { count } = buildTranscript(entries);
		expect(count).toBe(5);
	});
});
