// Sanity tests for prompt constants and focus presets in prompts.ts.
// Verifies structural correctness and completeness — not prose quality.
// No network, no live models, no OMP runtime required.

import { describe, expect, test } from "bun:test";
import { DEFAULT_FOCUS, FOCUS_PRESETS, REVIEWER_SYSTEM_PROMPT, TOOL_DESCRIPTION } from "./prompts";
import type { ReviewMode } from "./prompts";

// All ReviewMode values that must have a preset (excludes "general")
const PRESET_MODES: Array<Exclude<ReviewMode, "general">> = [
	"security",
	"performance",
	"tests",
	"architecture",
	"correctness",
	"privacy",
	"api-contract",
	"migration",
	"release",
];

// ---------------------------------------------------------------------------
// FOCUS_PRESETS
// ---------------------------------------------------------------------------

describe("FOCUS_PRESETS", () => {
	test("covers every non-general ReviewMode value", () => {
		for (const mode of PRESET_MODES) {
			expect(FOCUS_PRESETS).toHaveProperty(mode);
			expect(typeof FOCUS_PRESETS[mode]).toBe("string");
		}
	});

	test("all preset strings are non-empty and substantive (> 30 chars)", () => {
		for (const [mode, preset] of Object.entries(FOCUS_PRESETS)) {
			expect(preset.length).toBeGreaterThan(30);
		}
	});

	test("each preset is a distinct string (no copy-paste)", () => {
		const values = Object.values(FOCUS_PRESETS);
		expect(new Set(values).size).toBe(values.length);
	});

	test("has exactly the expected number of modes", () => {
		expect(Object.keys(FOCUS_PRESETS)).toHaveLength(PRESET_MODES.length);
	});

	test("security preset addresses security concerns", () => {
		const lower = FOCUS_PRESETS.security.toLowerCase();
		// Must mention at least one security concept
		const hasSecurity = lower.includes("inject") || lower.includes("auth") || lower.includes("secret");
		expect(hasSecurity).toBe(true);
	});

	test("performance preset addresses performance concerns", () => {
		const lower = FOCUS_PRESETS.performance.toLowerCase();
		const hasPerf = lower.includes("perform") || lower.includes("allocat") || lower.includes("complex");
		expect(hasPerf).toBe(true);
	});

	test("tests preset addresses testing concerns", () => {
		const lower = FOCUS_PRESETS.tests.toLowerCase();
		const hasTests = lower.includes("test") || lower.includes("branch") || lower.includes("assert");
		expect(hasTests).toBe(true);
	});

	test("architecture preset addresses design concerns", () => {
		const lower = FOCUS_PRESETS.architecture.toLowerCase();
		const hasArch = lower.includes("architect") || lower.includes("abstraction") || lower.includes("coupling");
		expect(hasArch).toBe(true);
	});

	test("correctness preset addresses correctness concerns", () => {
		const lower = FOCUS_PRESETS.correctness.toLowerCase();
		const hasCorrect = lower.includes("correct") || lower.includes("logic") || lower.includes("error");
		expect(hasCorrect).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// REVIEWER_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

describe("REVIEWER_SYSTEM_PROMPT", () => {
	test("is a non-empty string", () => {
		expect(typeof REVIEWER_SYSTEM_PROMPT).toBe("string");
		expect(REVIEWER_SYSTEM_PROMPT.length).toBeGreaterThan(100);
	});

	test("instructs the reviewer to end with a Verdict line", () => {
		expect(REVIEWER_SYSTEM_PROMPT).toContain("Verdict:");
	});

	test("names all three verdict values", () => {
		expect(REVIEWER_SYSTEM_PROMPT).toContain("SOUND");
		expect(REVIEWER_SYSTEM_PROMPT).toContain("SOUND_WITH_CAVEATS");
		expect(REVIEWER_SYSTEM_PROMPT).toContain("FLAWED");
	});

	test("includes adversarial framing (does not just ask to agree)", () => {
		const lower = REVIEWER_SYSTEM_PROMPT.toLowerCase();
		const hasAdversarial =
			lower.includes("adversar") || lower.includes("pressure") || lower.includes("independent");
		expect(hasAdversarial).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// TOOL_DESCRIPTION
// ---------------------------------------------------------------------------

describe("TOOL_DESCRIPTION", () => {
	test("is a non-empty string", () => {
		expect(typeof TOOL_DESCRIPTION).toBe("string");
		expect(TOOL_DESCRIPTION.length).toBeGreaterThan(100);
	});

	test("documents the scope parameter values", () => {
		expect(TOOL_DESCRIPTION).toContain("transcript");
		expect(TOOL_DESCRIPTION).toContain("diff");
		expect(TOOL_DESCRIPTION).toContain("both");
	});

	test("mentions the consent / data-forwarding notice", () => {
		const lower = TOOL_DESCRIPTION.toLowerCase();
		const hasConsent = lower.includes("consent") || lower.includes("forward") || lower.includes("vendor");
		expect(hasConsent).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// DEFAULT_FOCUS
// ---------------------------------------------------------------------------

describe("DEFAULT_FOCUS", () => {
	test("is a non-empty string", () => {
		expect(typeof DEFAULT_FOCUS).toBe("string");
		expect(DEFAULT_FOCUS.length).toBeGreaterThan(20);
	});

	test("is distinct from all preset values", () => {
		for (const preset of Object.values(FOCUS_PRESETS)) {
			expect(DEFAULT_FOCUS).not.toBe(preset);
		}
	});
});
