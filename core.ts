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
const REVIEW_META_LINE = /^\s*ReviewMeta\s*:\s*(\{.*\})\s*$/i;

export interface ReviewMeta {
	verdict?: Verdict;
	blockingIssues?: number;
	caveats?: number;
	confidence?: number;
}

function normalizeVerdictToken(value: unknown): Verdict | undefined {
	if (typeof value !== "string") return undefined;
	const token = value.replace(/[\s_-]+/g, "_").toUpperCase();
	if (token === "FLAWED") return "FLAWED";
	if (token === "SOUND_WITH_CAVEATS") return "SOUND_WITH_CAVEATS";
	if (token === "SOUND") return "SOUND";
	return undefined;
}

function boundedInteger(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.floor(value));
}

/** Parse the optional final `ReviewMeta: {...}` trailer without trusting arbitrary prose. */
export function parseReviewMeta(text: string): ReviewMeta | undefined {
	const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
		const match = lines[i]?.match(REVIEW_META_LINE);
		if (!match) continue;
		try {
			const parsed = JSON.parse(match[1]) as Record<string, unknown>;
			const verdict = normalizeVerdictToken(parsed.verdict);
			return {
				verdict,
				blockingIssues: boundedInteger(parsed.blockingIssues),
				caveats: boundedInteger(parsed.caveats),
				confidence: boundedInteger(parsed.confidence),
			};
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function verdictFromFinalLine(text: string): Verdict | undefined {
	const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
		const last = lines[i];
		if (!last || REVIEW_META_LINE.test(last)) continue;
		const match = last.match(FINAL_VERDICT_LINE);
		if (!match) return undefined;
		return normalizeVerdictToken(match[1]);
	}
	return undefined;
}

export function hasFinalVerdictLine(text: string): boolean {
	return verdictFromFinalLine(text) !== undefined;
}

/**
 * Extract the reviewer's verdict. Strong signals are the structured trailer and
 * final standalone `Verdict: …` line. This avoids treating quoted examples,
 * negations, or earlier-reviewer references as the reviewer's own verdict.
 * Falls back to severity keyword scan only when no strong signal is present.
 */
export function parseVerdict(text: string): Verdict | undefined {
	return parseReviewMeta(text)?.verdict ?? verdictFromFinalLine(text) ?? scanVerdict(text);
}

const VERDICT_SEVERITY: Record<Verdict, number> = { SOUND: 0, SOUND_WITH_CAVEATS: 1, FLAWED: 2 };

/** Pick the most severe verdict across a panel (FLAWED > SOUND_WITH_CAVEATS > SOUND). */
export function mostSevereVerdict(verdicts: ReadonlyArray<Verdict | undefined>): Verdict | undefined {
	let best: Verdict | undefined;
	for (const v of verdicts) {
		if (!v) continue;
		if (best === undefined || VERDICT_SEVERITY[v] > VERDICT_SEVERITY[best]) best = v;
	}
	return best;
}

export interface PanelReviewSummaryInput {
	reviewer: string;
	verdict?: Verdict;
	error?: string;
}

/** Deterministic panel digest: split/unanimous verdicts plus failures. */
export function summarizePanel(inputs: ReadonlyArray<PanelReviewSummaryInput>): string {
	const ok = inputs.filter(i => i.verdict);
	const failed = inputs.filter(i => !i.verdict && i.error);
	if (ok.length === 0) {
		return failed.length === 0 ? "No reviewer returned a parseable verdict." : `${failed.length} reviewer(s) failed.`;
	}
	const counts = new Map<Verdict, number>();
	for (const item of ok) counts.set(item.verdict!, (counts.get(item.verdict!) ?? 0) + 1);
	const parts = VERDICTS
		.map(v => `${v}: ${counts.get(v) ?? 0}`)
		.filter(p => !p.endsWith(": 0"));
	const split = counts.size === 1 ? `unanimous ${ok[0].verdict}` : `split (${parts.join(", ")})`;
	return failed.length === 0 ? split : `${split}; ${failed.length} reviewer(s) failed`;
}

export interface RedactionFinding {
	kind: string;
	severity: "block" | "redact";
	count: number;
}

export interface RedactionResult {
	text: string;
	findings: RedactionFinding[];
	blocked: boolean;
}


/** Scan secrets, redact medium-confidence values, and block high-confidence values unless explicitly allowed. */
export function scanAndRedactMaterial(text: string, allowSecrets = false): RedactionResult {
	if (!text.trim()) return { text, findings: [], blocked: false };
	const scan = scanSecrets(text);
	const findings: RedactionFinding[] = scan.matches.map(m => ({
		kind: m.kind,
		severity: m.confidence === "high" ? "block" : "redact",
		count: 1,
	}));
	return { text: redactSecrets(text), findings, blocked: scan.hasHigh && !allowSecrets };
}

/** Stable, deterministic non-cryptographic hash for stale-review detection. */
export function hashMaterial(parts: ReadonlyArray<string | undefined>): string {
	let h = 0x811c9dc5;
	for (const part of parts) {
		const text = part ?? "";
		for (let i = 0; i < text.length; i++) {
			h ^= text.charCodeAt(i);
			h = Math.imul(h, 0x01000193) >>> 0;
		}
		h ^= 0xff;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/**
 * Compare a stored material hash against the current one.
 * Returns "current" when they match, "changed" when they differ, "unknown" when
 * no stored hash is available (pre-hash run, missing scope data, or unreachable material).
 */
export function isStaleHash(
	stored: string | undefined,
	current: string,
): "current" | "changed" | "unknown" {
	if (!stored) return "unknown";
	return stored === current ? "current" : "changed";
}

export function globToRegExp(glob: string): RegExp {
	let out = "^";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				if (glob[i + 2] === "/") {
					out += "(?:.*/)?";
					i += 2;
				} else {
					out += ".*";
					i++;
				}
			} else {
				out += "[^/]*";
			}
		} else if (ch === "?") {
			out += "[^/]";
		} else {
			out += ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
		}
	}
	return new RegExp(`${out}$`);
}

export function matchesAnyGlob(path: string, globs: ReadonlyArray<string> | undefined): boolean {
	if (!globs || globs.length === 0) return false;
	const normalized = path.replace(/\\/g, "/");
	return globs.some(glob => globToRegExp(glob.replace(/\\/g, "/")).test(normalized));
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
	const configuredLabel = configured ? formatModel(configured) : undefined;

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
		if (label === sessionLabel && label !== configuredLabel) continue;
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

// ─── Secret scanning and redaction ───────────────────────────────────────────

/** Metadata about one detected secret. The matched value is never stored here. */
export interface SecretMatch {
	/** A stable category label — never the matched value. */
	kind: string;
	confidence: "high" | "medium";
}

export interface SecretScanResult {
	/** One entry per distinct kind detected (deduplicated by kind+confidence). */
	matches: SecretMatch[];
	hasHigh: boolean;
	hasMedium: boolean;
}

/**
 * Internal pattern table. Stored as source+flags strings so every call gets a
 * fresh, non-stateful RegExp instance — sharing a /g regex across calls would
 * silently skip matches due to stale `lastIndex`.
 *
 * For medium entries `replaceWith` drives `redactSecrets`: it may reference
 * capture group $1 (the key+separator prefix). The matched value is never
 * surfaced externally.
 */
interface SecretPatternEntry {
	kind: string;
	confidence: "high" | "medium";
	/** Regex source without flags — flags are applied per call. */
	source: string;
	flags: string;
	/** Replacement template for medium patterns used by `redactSecrets`. */
	replaceWith?: string;
}

const SECRET_PATTERNS: ReadonlyArray<SecretPatternEntry> = [
	// ── High confidence ──────────────────────────────────────────────────────
	// AWS IAM access-key ID prefixes (AKIA long-term, ASIA STS short-term, etc.)
	{
		kind: "aws-access-key",
		confidence: "high",
		source: "\\b(?:AKIA|ASIA|AIDA|AROA|ANPA|ANVA|APKA)[A-Z0-9]{16}\\b",
		flags: "",
	},
	// GitHub tokens: ghp_ (PAT), gho_ (OAuth), ghs_ (server-to-server),
	// ghu_ (user-to-server), ghr_ (refresh)
	{
		kind: "github-token",
		confidence: "high",
		source: "\\bgh[pousr]_[A-Za-z0-9]{36,}\\b",
		flags: "",
	},
	// GitHub fine-grained PATs
	{
		kind: "github-pat",
		confidence: "high",
		source: "\\bgithub_pat_[A-Za-z0-9_]{20,}\\b",
		flags: "",
	},
	// OpenAI-style sk- API keys (also used by Anthropic legacy, etc.)
	{
		kind: "openai-key",
		confidence: "high",
		source: "\\bsk-[A-Za-z0-9]{20,}\\b",
		flags: "",
	},
	// Slack tokens (bot xoxb-, user xoxp-, app-level xoxa-, OAuth xoxo-)
	{
		kind: "slack-token",
		confidence: "high",
		source: "\\bxox[bpoa]-\\d+-[A-Za-z0-9-]+\\b",
		flags: "",
	},
	// PEM private key header (RSA, EC, DSA, OpenSSH)
	{
		kind: "private-key",
		confidence: "high",
		source: "-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
		flags: "",
	},
	// JSON Web Token: three base64url-encoded segments (header.payload.sig)
	{
		kind: "jwt",
		confidence: "high",
		source: "\\bey[A-Za-z0-9-_]{10,}\\.[A-Za-z0-9-_]{10,}\\.[A-Za-z0-9-_]{10,}\\b",
		flags: "",
	},
	// Azure Storage connection-string account keys.
	{
		kind: "azure-storage-key",
		confidence: "high",
		source: "\\bAccountKey=[^;\\s]+",
		flags: "i",
	},
	// Shared Access Signature query-string signatures.
	{
		kind: "sas-signature",
		confidence: "high",
		source: "[?&]sig=[^&\\s]+",
		flags: "i",
	},

	// ── Medium confidence — env-file / config key=value assignment patterns ──
	// Value must be ≥8 non-whitespace chars; placeholder sigils (${ {{ < null)
	// are excluded to keep false-positive rates low.
	// group $1 = key+separator, retained by replaceWith so the key name is
	// preserved in the redacted output.
	{
		kind: "password-assignment",
		confidence: "medium",
		source:
			"(\\bpassw(?:or)?d\\s*[=:]\\s*)" +
			'(?!["\']?(?:null\\b|undefined\\b|true\\b|false\\b|none\\b|<[^>]{1,40}>|\\$\\{|\\{\\{|%\\{))' +
			'(?:"[^"\\r\\n]{8,}"|\'[^\'\\r\\n]{8,}\'|[^\\s"\'`=,;{}\\r\\n]{8,})',
		flags: "i",
		replaceWith: "$1[REDACTED]",
	},
	{
		kind: "api-key-assignment",
		confidence: "medium",
		source:
			"(\\bapi[_-]?key\\s*[=:]\\s*)" +
			'(?!["\']?(?:null\\b|undefined\\b|<[^>]{1,40}>|\\$\\{|\\{\\{))' +
			'(?:"[^"\\r\\n]{8,}"|\'[^\'\\r\\n]{8,}\'|[^\\s"\'`=,;{}\\r\\n]{8,})',
		flags: "i",
		replaceWith: "$1[REDACTED]",
	},
	{
		kind: "client-secret-assignment",
		confidence: "medium",
		source:
			"(\\bclient[_-]?secret\\s*[=:]\\s*)" +
			'(?!["\']?(?:null\\b|undefined\\b|<[^>]{1,40}>|\\$\\{|\\{\\{))' +
			'(?:"[^"\\r\\n]{8,}"|\'[^\'\\r\\n]{8,}\'|[^\\s"\'`=,;{}\\r\\n]{8,})',
		flags: "i",
		replaceWith: "$1[REDACTED]",
	},
	{
		kind: "token-assignment",
		confidence: "medium",
		source:
			"(\\b(?:access|auth|bearer|refresh)[_-]?token\\s*[=:]\\s*)" +
			'(?!["\']?(?:null\\b|undefined\\b|<[^>]{1,40}>|\\$\\{|\\{\\{))' +
			'(?:"[^"\\r\\n]{8,}"|\'[^\'\\r\\n]{8,}\'|[^\\s"\'`=,;{}\\r\\n]{8,})',
		flags: "i",
		replaceWith: "$1[REDACTED]",
	},
];

/**
 * Scan `text` for likely secrets. Returns metadata only — matched values are
 * never included in the result, so the output is safe to log or display.
 *
 * Results are deduplicated: multiple occurrences of the same kind produce a
 * single entry so callers receive a clean per-kind summary.
 */
export function scanSecrets(text: string): SecretScanResult {
	const seen = new Set<string>();
	const matches: SecretMatch[] = [];
	for (const entry of SECRET_PATTERNS) {
		const key = `${entry.confidence}:${entry.kind}`;
		if (seen.has(key)) continue;
		const re = new RegExp(entry.source, entry.flags);
		if (re.test(text)) {
			seen.add(key);
			matches.push({ kind: entry.kind, confidence: entry.confidence });
		}
	}
	return {
		matches,
		hasHigh: matches.some(m => m.confidence === "high"),
		hasMedium: matches.some(m => m.confidence === "medium"),
	};
}

/**
 * Replace medium-confidence secret values in `text` with `[REDACTED]`,
 * preserving the key name and separator (e.g. `password = "s3cr3t"` →
 * `password = [REDACTED]`).
 *
 * High-confidence secrets are left untouched — the caller blocks the review
 * or opts in via `OMP_SECOND_OPINION_ALLOW_SECRETS=1`.
 */
export function redactSecrets(text: string): string {
	let result = text;
	for (const entry of SECRET_PATTERNS) {
		if (entry.confidence !== "medium" || !entry.replaceWith) continue;
		const re = new RegExp(entry.source, entry.flags + "g");
		result = result.replace(re, entry.replaceWith);
	}
	return result;
}
