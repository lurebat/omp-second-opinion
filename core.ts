// Pure, side-effect-free helpers: transcript rendering, verdict parsing, model
// family extraction, selector resolution, reviewer ordering, effort clamping.
// Ported from the upstream `second_opinion` PR (#1918) and adapted to the
// runtime-only type surface available to an extension.

import type { Effort, ModelLike, SessionEntry, ThinkingLevel } from "./types";

export const VERDICTS = ["SOUND", "SOUND_WITH_CAVEATS", "FLAWED"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Soft cap on transcript characters fed to the reviewer (keeps the newest turns). */
const CHAR_BUDGET = 48_000;
/** Per-tool-result truncation so a single noisy result cannot dominate the budget. */
const TOOL_RESULT_TRUNC = 400;
const TRANSCRIPT_TRUNC_MARKER = " …[truncated to transcript budget]";

const ROLE_LABELS: Record<string, string> = {
	user: "USER",
	assistant: "ASSISTANT",
	developer: "DEVELOPER",
	tool: "TOOL RESULT",
	compaction: "COMPACTION SUMMARY",
	branch_summary: "BRANCH SUMMARY",
};

interface RenderedTurn {
	role: string;
	text: string;
}

/** Flatten message/content into plain text. Tool calls become markers; thinking/images dropped. */
export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string; name?: string };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (b.type === "toolCall" && b.name) parts.push(`[tool call: ${b.name}]`);
	}
	return parts.join("\n");
}

/** Render a single session entry into a transcript turn, or null to skip it. */
export function renderEntry(entry: SessionEntry): RenderedTurn | null {
	if (entry.type === "message" && entry.message) {
		const msg = entry.message;
		if (typeof msg.role !== "string") return null;
		if (msg.role === "toolResult") {
			const raw = textFromContent(msg.content);
			if (!raw.trim()) return null;
			const trunc = raw.length > TOOL_RESULT_TRUNC ? `${raw.slice(0, TOOL_RESULT_TRUNC)} …[truncated]` : raw;
			return { role: "tool", text: `[${msg.toolName ?? "tool"}] ${trunc}` };
		}
		const text = textFromContent(msg.content);
		if (!text.trim()) return null;
		return { role: msg.role, text };
	}
	if (entry.type === "custom_message") {
		const text = textFromContent(entry.content);
		if (!text.trim()) return null;
		return { role: `note:${entry.customType ?? "custom"}`, text };
	}
	if (entry.type === "compaction") {
		const summary = entry.summary ?? "";
		if (!summary.trim()) return null;
		return { role: "compaction", text: `[compacted ${entry.tokensBefore ?? 0} prior tokens]\n${summary}` };
	}
	if (entry.type === "branch_summary") {
		const summary = entry.summary ?? "";
		if (!summary.trim()) return null;
		return { role: "branch_summary", text: `[from ${entry.fromId ?? "?"}]\n${summary}` };
	}
	return null;
}

/**
 * Build a transcript from session entries (current branch, path-from-leaf),
 * keeping the most recent within the char budget. `lookback` counts rendered
 * transcript turns, not raw entries.
 */
export function buildTranscript(entries: SessionEntry[], lookback?: number): { text: string; count: number } {
	const rendered: RenderedTurn[] = [];
	for (const entry of entries) {
		const turn = renderEntry(entry);
		if (turn) rendered.push(turn);
	}
	const scoped = typeof lookback === "number" && lookback > 0 ? rendered.slice(-lookback) : rendered;
	const blocks = scoped.map(t => `## ${ROLE_LABELS[t.role] ?? t.role.toUpperCase()}\n${t.text}`);

	const kept: string[] = [];
	let total = 0;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const separator = kept.length > 0 ? 2 : 0;
		const nextTotal = total + separator + blocks[i].length;
		if (nextTotal > CHAR_BUDGET) {
			if (kept.length === 0) {
				const limit = Math.max(0, CHAR_BUDGET - TRANSCRIPT_TRUNC_MARKER.length);
				kept.unshift(`${blocks[i].slice(0, limit)}${TRANSCRIPT_TRUNC_MARKER}`);
			}
			break;
		}
		kept.unshift(blocks[i]);
		total = nextTotal;
	}
	return { text: kept.join("\n\n"), count: kept.length };
}

const VERDICT_SCAN: ReadonlyArray<readonly [Verdict, RegExp]> = [
	["FLAWED", /\bFLAWED\b/i],
	["SOUND_WITH_CAVEATS", /\bSOUND[\s_-]?WITH[\s_-]?CAVEATS\b/i],
	["SOUND", /\bSOUND\b/i],
];

/** Keyword-scan a reviewer reply for its verdict. Most-severe match wins. */
export function scanVerdict(text: string): Verdict | undefined {
	for (const [verdict, pattern] of VERDICT_SCAN) {
		if (pattern.test(text)) return verdict;
	}
	return undefined;
}

const FINAL_VERDICT_LINE = /^\s*\*{0,2}verdict\*{0,2}\s*:\s*\*{0,2}(SOUND[\s_-]?WITH[\s_-]?CAVEATS|FLAWED|SOUND)\*{0,2}\s*\.?\s*$/i;

function verdictFromFinalLine(text: string): Verdict | undefined {
	const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	const last = lines[lines.length - 1];
	if (!last) return undefined;
	const match = last.match(FINAL_VERDICT_LINE);
	if (!match) return undefined;
	const token = match[1].replace(/[\s_-]+/g, "_").toUpperCase();
	if (token === "FLAWED") return "FLAWED";
	if (token === "SOUND_WITH_CAVEATS") return "SOUND_WITH_CAVEATS";
	return "SOUND";
}

export function hasFinalVerdictLine(text: string): boolean {
	return verdictFromFinalLine(text) !== undefined;
}

/**
 * Extract the reviewer's verdict. The only strong signal is the final
 * standalone `Verdict: …` line. This avoids treating quoted examples,
 * negations, or earlier-reviewer references as the reviewer's own verdict.
 * Falls back to severity keyword scan only when the final line is absent.
 */
export function parseVerdict(text: string): Verdict | undefined {
	return verdictFromFinalLine(text) ?? scanVerdict(text);
}

/**
 * Family = the leading series token of the model's canonical id (e.g.
 * `claude-opus-4-8-1m` → `claude`, `gemini-3-pro-preview` → `gemini`,
 * `gpt-5-5` → `gpt`). Mirrors the upstream `getModelSeries`: point releases
 * and 1m/mirror variants fold onto one lineage. Falls back to the provider.
 */
export function modelFamily(model: ModelLike, canonicalId: string | undefined): string {
	const basis = (canonicalId ?? model.id).toLowerCase();
	const lead = basis.match(/^[a-z]+/);
	if (lead && lead[0].length >= 2) return lead[0];
	return model.provider.toLowerCase();
}

/** Stable `provider/id` label for a model. */
export function formatModel(model: ModelLike): string {
	return `${model.provider}/${model.id}`;
}

const EFFORT_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/i;

/**
 * Resolve a selector string (`provider/id`, `id`, or a substring, optionally
 * suffixed with `:effort`) to one of the available models. Exact id/prov`/`id
 * wins, then prefix, then substring on id, then substring on name.
 */
export function resolveSelector(selector: string, available: ModelLike[]): ModelLike | undefined {
	const cleaned = selector.trim().replace(EFFORT_SUFFIX, "").trim();
	if (!cleaned) return undefined;
	const lower = cleaned.toLowerCase();

	if (cleaned.includes("/")) {
		const slash = cleaned.indexOf("/");
		const provider = cleaned.slice(0, slash).toLowerCase();
		const id = cleaned.slice(slash + 1).toLowerCase();
		const sameProvider = available.filter(m => m.provider.toLowerCase() === provider);
		const pool = sameProvider.length > 0 ? sameProvider : available;
		return (
			pool.find(m => m.id.toLowerCase() === id) ??
			pool.find(m => m.id.toLowerCase().startsWith(id)) ??
			pool.find(m => m.id.toLowerCase().includes(id))
		);
	}

	return (
		available.find(m => m.id.toLowerCase() === lower) ??
		available.find(m => m.id.toLowerCase().startsWith(lower)) ??
		available.find(m => m.id.toLowerCase().includes(lower)) ??
		available.find(m => (m.name ?? "").toLowerCase().includes(lower))
	);
}

const EFFORT_BY_SUFFIX: Record<string, Effort> = {
	off: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "xhigh",
};

/**
 * Parse the `:effort` suffix of a model selector (e.g. `provider/id:xhigh`) into
 * a reviewer effort, or undefined when absent. Lets a configured reviewer or
 * `modelRoles.slow` carry its own reasoning level — `…:xhigh` is honored, not
 * silently dropped.
 */
export function parseSelectorEffort(selector: string): Effort | undefined {
	const match = selector.trim().match(EFFORT_SUFFIX);
	if (!match) return undefined;
	return EFFORT_BY_SUFFIX[match[1].toLowerCase()];
}

/**
 * Order reviewer candidates for the default (non-explicit) path. Cross-family
 * first (they do not share the session's blind spots); within cross-family,
 * same-provider-as-session first (its auth/integrator is known to work). The
 * configured reviewer and slow model lead if supplied. The session model and
 * duplicates are dropped. Returns a non-empty list whenever any model exists.
 */
export function orderCandidates(args: {
	available: ModelLike[];
	sessionModel: ModelLike | undefined;
	sessionFamily: string | undefined;
	familyOf: (model: ModelLike) => string;
	configured: ModelLike | undefined;
	slow: ModelLike | undefined;
}): ModelLike[] {
	const { available, sessionModel, sessionFamily, familyOf, configured, slow } = args;
	const sessionLabel = sessionModel ? formatModel(sessionModel) : undefined;
	const sessionProvider = sessionModel?.provider.toLowerCase();

	const crossFamily = available.filter(m => !sessionFamily || familyOf(m) !== sessionFamily);
	const crossSameProvider = crossFamily.filter(m => m.provider.toLowerCase() === sessionProvider);
	const crossOtherProvider = crossFamily.filter(m => m.provider.toLowerCase() !== sessionProvider);

	const ordered: (ModelLike | undefined)[] = [
		configured,
		slow && (!sessionFamily || familyOf(slow) !== sessionFamily) ? slow : undefined,
		...crossSameProvider,
		...crossOtherProvider,
		slow,
		...available,
	];

	const seen = new Set<string>();
	const result: ModelLike[] = [];
	for (const model of ordered) {
		if (!model) continue;
		const label = formatModel(model);
		if (label === sessionLabel) continue;
		if (seen.has(label)) continue;
		seen.add(label);
		result.push(model);
	}
	return result;
}

const THINKING_ORDER: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

/** Map the reviewer `effort` to a model-supported thinking level, or undefined to skip. */
export function clampThinking(model: ModelLike, effort: Effort): ThinkingLevel | undefined {
	if (model.reasoning === false) return undefined;
	const want: ThinkingLevel = effort === "off" ? "minimal" : effort;
	const supported = model.thinking?.efforts?.filter((e): e is ThinkingLevel =>
		(THINKING_ORDER as string[]).includes(e),
	);
	if (!supported || supported.length === 0) return want;
	if (supported.includes(want)) return want;
	const wantRank = THINKING_ORDER.indexOf(want);
	let best: ThinkingLevel | undefined;
	let bestRank = -1;
	for (const level of supported) {
		const rank = THINKING_ORDER.indexOf(level);
		if (rank <= wantRank && rank > bestRank) {
			best = level;
			bestRank = rank;
		}
	}
	return best ?? supported[0];
}
