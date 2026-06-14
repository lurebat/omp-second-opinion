// omp-second-opinion — an independent, cross-family adversarial second-opinion
// review tool for oh-my-pi, implemented purely against the public extension API
// plus runtime-injected SDK exports (`pi.pi`). No internal packages are imported
// (they do not resolve inside the compiled binary's extension loader), and none
// of the upstream PR's internal additions — the `secondopinion` model role,
// `getModelSeries`, the `second_opinion` telemetry kind — are relied upon.
//
// The reviewer runs as an ephemeral, in-memory, tool-less one-shot session on a
// deliberately different model: branch transcript + adversarial prompt → verdict.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	buildTranscript,
	clampThinking,
	formatModel,
	hasFinalVerdictLine,
	modelFamily,
	orderCandidates,
	parseSelectorEffort,
	parseVerdict,
	resolveSelector,
	textFromContent,
} from "./core";
import { REVIEWER_SYSTEM_PROMPT, TOOL_DESCRIPTION } from "./prompts";
import type {
	AgentToolResult,
	Effort,
	CommandContextLike,
	ExtensionApi,
	ExtensionContextLike,
	InnerSession,
	ModelLike,
	SessionEvent,
	ThinkingLevel,
	UiSelectOption,
} from "./types";

const STATE_FILE = "second-opinion.json";
const CONFIGURED_ROLE = "secondopinion";
const SLOW_ROLE = "slow";
const MAX_AUTO_ATTEMPTS = 4;
const DEFAULT_REVIEW_TIMEOUT_MS = 180_000;
const IDLE_WAIT_GRACE_MS = 5_000;

interface ExtensionState {
	consented?: boolean;
	reviewer?: string;
	fingerprint?: string;
}

type ProgressLevel = "info" | "warn" | "error";
type ProgressFn = (message: string, level?: ProgressLevel) => void;

function isEffort(value: unknown): value is Effort {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	);
}

/** Read a model role without throwing on builds where the role is unknown. */
function safeRole(pi: ExtensionApi, role: string): string | undefined {
	try {
		return pi.pi.Settings?.instance?.getModelRole(role)?.trim() || undefined;
	} catch {
		return undefined;
	}
}

function agentDir(pi: ExtensionApi): string {
	const fromSettings = pi.pi.Settings?.instance?.getAgentDir?.();
	if (fromSettings) return fromSettings;
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return env;
	return join(homedir(), ".omp", "agent");
}

function loadState(pi: ExtensionApi): ExtensionState {
	try {
		const raw = readFileSync(join(agentDir(pi), STATE_FILE), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object") return parsed as ExtensionState;
	} catch {
		// missing or malformed — start fresh
	}
	return {};
}

function saveState(pi: ExtensionApi, state: ExtensionState): void {
	try {
		const dir = agentDir(pi);
		mkdirSync(dir, { recursive: true });
		const target = join(dir, STATE_FILE);
		// Atomic: write a unique temp file, then rename over the target. rename is
		// atomic on the same volume, so a concurrent reader never sees a partial file.
		const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
		writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
		renameSync(tmp, target);
	} catch (err) {
		pi.logger?.warn?.(`[second-opinion] could not persist state: ${String(err)}`);
	}
}

function envConsented(): boolean {
	const v = (process.env.OMP_SECOND_OPINION_CONSENT ?? "").toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

function envDisabled(name: string): boolean {
	const v = (process.env[name] ?? "").toLowerCase();
	return v === "0" || v === "false" || v === "no" || v === "off";
}

function commandAutoHandoff(): boolean {
	return !envDisabled("OMP_SECOND_OPINION_AUTO_HANDOFF");
}

function envPositiveInt(name: string): number | undefined {
	const raw = process.env[name]?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return Math.floor(value);
}

function reviewTimeoutMs(): number {
	const ms = envPositiveInt("OMP_SECOND_OPINION_TIMEOUT_MS");
	if (ms !== undefined) return ms;
	const seconds = envPositiveInt("OMP_SECOND_OPINION_TIMEOUT_SECONDS");
	if (seconds !== undefined) return seconds * 1000;
	return DEFAULT_REVIEW_TIMEOUT_MS;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

async function waitForIdleBriefly(ctx: CommandContextLike, progress: ProgressFn): Promise<void> {
	if (!ctx.waitForIdle) return;
	progress("Waiting for the current turn to finish…");
	const timeout = Promise.withResolvers<"timeout">();
	let timer: ReturnType<typeof setTimeout> | undefined;
	timer = setTimeout(() => timeout.resolve("timeout"), IDLE_WAIT_GRACE_MS);
	const result = await Promise.race([
		ctx.waitForIdle().then(() => "idle" as const, () => "idle" as const),
		timeout.promise,
	]);
	if (timer) clearTimeout(timer);
	if (result === "timeout") {
		progress("Still waiting for idle; continuing with the current transcript snapshot.", "warn");
	}
}

/** Run a single one-shot review on `reviewer`; returns prose or a surfaced error. */
async function runReview(
	pi: ExtensionApi,
	ctx: ExtensionContextLike,
	reviewer: ModelLike,
	userText: string,
	thinkingLevel: ThinkingLevel | undefined,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<{ text: string; error?: string }> {
	if (signal?.aborted) return { text: "", error: "aborted" };

	const options: Record<string, unknown> = {
		model: reviewer,
		modelRegistry: ctx.modelRegistry,
		authStorage: ctx.modelRegistry?.authStorage,
		sessionManager: pi.pi.SessionManager.inMemory(),
		systemPrompt: () => REVIEWER_SYSTEM_PROMPT,
		toolNames: [],
		enableMCP: false,
		enableLsp: false,
		disableExtensionDiscovery: true,
		extensions: [],
	};
	if (thinkingLevel) options.thinkingLevel = thinkingLevel;

	const { session } = await pi.pi.createAgentSession(options);
	const inner = session as InnerSession;

	let accumulated = "";
	let finalMessage: SessionEvent["message"];
	const unsubscribe = inner.subscribe((event: SessionEvent) => {
		if (event.type === "message_update") {
			const delta = event.assistantMessageEvent;
			if (delta?.type === "text_delta" && typeof delta.delta === "string") accumulated += delta.delta;
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			finalMessage = event.message;
		}
	});

	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const onAbort = () => inner.abort?.();
	signal?.addEventListener("abort", onAbort);
	try {
		const timeout = Promise.withResolvers<"timeout">();
		timer = setTimeout(() => {
			timedOut = true;
			inner.abort?.();
			timeout.resolve("timeout");
		}, timeoutMs);
		const prompt = inner.prompt(userText).then(() => "done" as const);
		const result = await Promise.race([prompt, timeout.promise]);
		if (result === "timeout") return { text: "", error: `timed out after ${formatDuration(timeoutMs)}` };
	} catch (err) {
		if (signal?.aborted) return { text: "", error: "aborted" };
		if (timedOut) return { text: "", error: `timed out after ${formatDuration(timeoutMs)}` };
		return { text: "", error: err instanceof Error ? err.message : String(err) };
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		await inner.dispose().catch(() => undefined);
	}

	if (finalMessage?.stopReason === "error") {
		return { text: "", error: finalMessage.errorMessage ?? "reviewer request failed" };
	}
	if (signal?.aborted) return { text: "", error: "aborted" };
	const finalText = finalMessage ? textFromContent(finalMessage.content) : "";
	return { text: (finalText || accumulated).trim() };
}

interface ResolvedPlan {
	candidates: ModelLike[];
	source: "explicit" | "configured" | "auto";
	sessionModel: ModelLike | undefined;
	sessionFamily: string | undefined;
	familyOf: (model: ModelLike) => string;
	/** Effort carried by the chosen selector's `:effort` suffix (e.g. role `…:xhigh`). */
	effortHint?: Effort;
}

/** Pick the reviewer candidate list, running consent + the first-run picker as needed. */
async function planReviewers(
	pi: ExtensionApi,
	ctx: ExtensionContextLike,
	available: ModelLike[],
	explicitSelector: string | undefined,
): Promise<ResolvedPlan> {
	const registry = ctx.modelRegistry;
	const familyOf = (model: ModelLike): string =>
		modelFamily(model, registry?.getCanonicalId(model));
	const sessionModel = ctx.model;
	const sessionFamily = sessionModel ? familyOf(sessionModel) : undefined;

	if (explicitSelector) {
		const picked = resolveSelector(explicitSelector, available);
		if (!picked) {
			const ids = available.slice(0, 12).map(formatModel).join(", ");
			throw new Error(`model "${explicitSelector}" not found. Available include: ${ids}`);
		}
		return {
			candidates: [picked],
			source: "explicit",
			sessionModel,
			sessionFamily,
			familyOf,
			effortHint: parseSelectorEffort(explicitSelector),
		};
	}

	const state = loadState(pi);
	const envSelector = process.env.OMP_SECOND_OPINION_MODEL?.trim() || undefined;
	const roleSelector = safeRole(pi, CONFIGURED_ROLE);
	const savedSelector = state.reviewer?.trim() || undefined;
	// Operational/env override first, then explicit config role, then the saved picker.
	// A saved same-family reviewer is only reused for the session family it was picked for;
	// after a family change it is stale and the cross-family default path takes over.
	let configured: ModelLike | undefined;
	let configuredSelector: string | undefined;
	for (const choice of [
		{ selector: envSelector, source: "env" },
		{ selector: roleSelector, source: "role" },
		{ selector: savedSelector, source: "saved" },
	] as const) {
		if (!choice.selector) continue;
		const picked = resolveSelector(choice.selector, available);
		if (!picked) continue;
		if (
			choice.source === "saved" &&
			sessionFamily &&
			familyOf(picked) === sessionFamily &&
			state.fingerprint !== sessionFamily
		) {
			continue;
		}
		configured = picked;
		configuredSelector = choice.selector;
		break;
	}
	const slowSelector = safeRole(pi, SLOW_ROLE);
	const slow = slowSelector ? resolveSelector(slowSelector, available) : undefined;
	// Inherit the chosen selector's `:effort` suffix: the accepted configured reviewer if set,
	// otherwise the slow role that leads the auto fallback (e.g. slow = `…:xhigh`).
	let effortHint =
		(configured && configuredSelector ? parseSelectorEffort(configuredSelector) : undefined) ??
		(slow && slowSelector ? parseSelectorEffort(slowSelector) : undefined);

	// First-run / family-change interactive picker (only when nothing is configured).
	if (!configured && ctx.hasUI && ctx.ui && state.fingerprint !== sessionFamily) {
		const picked = await runPicker(ctx, available, slow, sessionModel, familyOf);
		const next: ExtensionState = { ...state, fingerprint: sessionFamily };
		if (picked) {
			configured = picked;
			next.reviewer = formatModel(picked);
		}
		saveState(pi, next);
	}

	const candidates = orderCandidates({
		available,
		sessionModel,
		sessionFamily,
		familyOf,
		configured,
		slow,
	}).slice(0, MAX_AUTO_ATTEMPTS);
	return {
		candidates,
		source: configured ? "configured" : "auto",
		sessionModel,
		sessionFamily,
		familyOf,
		effortHint,
	};
}

/** Interactive reviewer picker. Returns the chosen model, or undefined if dismissed. */
async function runPicker(
	ctx: ExtensionContextLike,
	available: ModelLike[],
	defaultModel: ModelLike | undefined,
	sessionModel: ModelLike | undefined,
	familyOf: (model: ModelLike) => string,
): Promise<ModelLike | undefined> {
	const ui = ctx.ui;
	if (!ui) return undefined;
	const sessionFamily = sessionModel ? familyOf(sessionModel) : undefined;
	const defaultLabel = defaultModel ? formatModel(defaultModel) : undefined;
	const byLabel = new Map<string, ModelLike>();
	const options: UiSelectOption[] = available.map(model => {
		const label = formatModel(model);
		byLabel.set(label, model);
		const tags: string[] = [];
		if (label === defaultLabel) tags.push("suggested");
		if (sessionFamily && familyOf(model) === sessionFamily) tags.push("⚠ same family as session — weaker review");
		return tags.length > 0 ? { label, description: tags.join(" · ") } : { label };
	});
	const initialIndex = defaultLabel ? Math.max(0, options.findIndex(o => o.label === defaultLabel)) : 0;

	for (;;) {
		const chosen = await ui.select("Second-opinion reviewer (saved as default)", options, { initialIndex });
		if (chosen === undefined) return undefined;
		const picked = byLabel.get(chosen);
		if (!picked) return undefined;
		if (sessionFamily && familyOf(picked) === sessionFamily) {
			const ok = await ui.confirm(
				"Same-family reviewer",
				`${formatModel(picked)} shares the ${familyOf(picked)} family with your session model. ` +
					"Same-family reviews are weaker — they share blind spots. Use it anyway?",
			);
			if (!ok) continue;
		}
		return picked;
	}
}

interface SecondOpinionOutcome {
	body: string;
	details: Record<string, unknown>;
}

/** Full second-opinion flow shared by the tool and the slash command. */
async function runSecondOpinion(
	pi: ExtensionApi,
	ctx: ExtensionContextLike,
	params: { focus?: string; model?: string; effort?: Effort; lookback?: number },
	signal: AbortSignal | undefined,
	progress?: ProgressFn,
): Promise<SecondOpinionOutcome> {
	const registry = ctx.modelRegistry;
	if (!ctx.sessionManager) throw new Error("second_opinion has no session transcript to review.");
	if (!registry) throw new Error("Model registry is unavailable for second_opinion.");
	const available = registry.getAvailable();
	if (available.length === 0) throw new Error("No authenticated models available for second_opinion.");

	progress?.("Preparing transcript for second opinion…");
	const { text: transcript, count } = buildTranscript(ctx.sessionManager.getBranch(), params.lookback);
	if (!transcript.trim()) throw new Error("second_opinion has no prior conversation context to review.");
	progress?.(`Transcript ready: ${count} entries, ${transcript.length} characters.`);

	// One-time data-disclosure consent (interactive only; headless implies consent).
	if (ctx.hasUI && ctx.ui && !envConsented() && !loadState(pi).consented) {
		const ok = await ctx.ui.confirm(
			"Second opinion — data disclosure",
			"This sends your full conversation transcript — including tool outputs and any file contents in it — to a " +
				"separate model, which may be a different vendor than your session model. Continue?",
		);
		if (!ok) throw new Error("second_opinion cancelled: transcript sharing was declined.");
		saveState(pi, { ...loadState(pi), consented: true });
	}

	progress?.("Selecting second-opinion reviewer…");
	const plan = await planReviewers(pi, ctx, available, params.model?.trim() || undefined);
	// Explicit param wins; else the configured selector's `:effort` suffix; else medium.
	const effort: Effort = params.effort ?? plan.effortHint ?? "medium";
	const timeoutMs = reviewTimeoutMs();
	progress?.(
		`Reviewer candidates: ${plan.candidates.map(formatModel).join(", ") || "none"}; effort=${effort}; timeout=${formatDuration(timeoutMs)}.`,
	);
	const focus =
		params.focus?.trim() ||
		"Independently review the assistant's most recent findings, plan, and code for correctness errors, " +
			"missed edge cases, faulty reasoning, and unstated assumptions. Be adversarial; do not rubber-stamp.";
	const userText = `${focus}\n\n---\nPrior conversation transcript (oldest first, most recent last):\n\n${transcript}`;

	const failures: string[] = [];
	for (const reviewer of plan.candidates) {
		const reviewerLabel = formatModel(reviewer);
		progress?.(`Checking access for ${reviewerLabel}…`);
		const apiKey = await registry.getApiKey(reviewer);
		if (!apiKey) {
			const failure = `${reviewerLabel}: no API key`;
			failures.push(failure);
			progress?.(failure, "warn");
			if (plan.source === "explicit") break;
			continue;
		}
		const thinkingLevel = clampThinking(reviewer, effort);
		const started = Date.now();
		progress?.(
			`Waiting for ${reviewerLabel}${thinkingLevel ? ` (${thinkingLevel})` : ""}…`,
		);
		const { text, error } = await runReview(pi, ctx, reviewer, userText, thinkingLevel, signal, timeoutMs);
		if (error === "aborted") throw new Error("second_opinion review aborted.");
		if (error || !text) {
			const failure = `${reviewerLabel}: ${error ?? "empty review"}`;
			failures.push(failure);
			progress?.(failure, "warn");
			if (plan.source === "explicit") break;
			continue;
		}
		progress?.(`Received ${reviewerLabel} review in ${formatDuration(Date.now() - started)}.`);

		const verdict = parseVerdict(text);
		const body = verdict && !hasFinalVerdictLine(text) ? `${text}\n\nVerdict: ${verdict}` : text;
		const sameFamily = plan.sessionFamily ? plan.familyOf(reviewer) === plan.sessionFamily : false;
		return {
			body,
			details: {
				verdict,
				reviewerModel: reviewerLabel,
				sessionModel: plan.sessionModel ? formatModel(plan.sessionModel) : undefined,
				source: plan.source,
				sameFamily,
				effort,
				timeoutMs,
				entriesIncluded: count,
				transcriptChars: transcript.length,
			},
		};
	}

	const detail = failures.length > 0 ? ` Tried: ${failures.join("; ")}.` : "";
	throw new Error(`second_opinion could not obtain a review from any reviewer.${detail}`);
}

export default function secondOpinionExtension(pi: ExtensionApi): void {
	const z = pi.zod;
	pi.setLabel("Second Opinion");

	pi.registerTool({
		name: "second_opinion",
		label: "Second Opinion",
		summary: "Get an independent second-opinion review from a different model",
		description: TOOL_DESCRIPTION,
		approval: "read",
		strict: false,
		parameters: z
			.object({
				focus: z
					.string()
					.describe("What the reviewer should pressure-test. Omit for a general adversarial review.")
					.optional(),
				model: z
					.string()
					.describe('Explicit reviewer selector ("provider/id", "id", or substring). Bypasses the configured reviewer.')
					.optional(),
				effort: z
					.enum(["off", "minimal", "low", "medium", "high", "xhigh"])
					.describe(
						"Reviewer reasoning effort, clamped to what the model supports. Omit to use the configured reviewer's level (e.g. modelRoles.slow `…:xhigh`), else medium.",
					)
					.optional(),
				lookback: z
					.number()
					.int()
					.positive()
					.describe("Limit to the N most recent message turns. Omit to include all that fit the budget.")
					.optional(),
			})
			.strict(),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const progress: ProgressFn | undefined = onUpdate
				? (message, level = "info") =>
					onUpdate({
						content: [{ type: "text", text: message }],
						details: { phase: "progress", level },
					})
				: undefined;
			const result = await runSecondOpinion(
				pi,
				ctx,
				{
					focus: typeof params.focus === "string" ? params.focus : undefined,
					model: typeof params.model === "string" ? params.model : undefined,
					effort: isEffort(params.effort) ? params.effort : undefined,
					lookback: typeof params.lookback === "number" ? params.lookback : undefined,
				},
				signal,
				progress,
			);
			const output: AgentToolResult = {
				content: [{ type: "text", text: result.body }],
				details: result.details,
			};
			return output;
		},
	});

	pi.registerCommand("second-opinion", {
		description: "Get an independent cross-model review of the current conversation",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const progress: ProgressFn = (message, level = "info") => ctx.ui?.notify(message, level);
			progress("Requesting a second opinion…");
			try {
				await waitForIdleBriefly(ctx, progress);
				const result = await runSecondOpinion(
					pi,
					ctx,
					{ focus: args.trim() || undefined },
					undefined,
					progress,
				);
				const verdict = typeof result.details.verdict === "string" ? result.details.verdict : "—";
				const reviewer = String(result.details.reviewerModel ?? "reviewer");
				const autoHandoff = commandAutoHandoff();
				const followUp = autoHandoff
					? "Assess this second opinion against your current direction: adopt the valid points, " +
						"briefly push back (with reasons) on any you disagree with, and present a concrete, " +
						"updated plan for how to proceed."
					: "Auto hand-off is disabled by OMP_SECOND_OPINION_AUTO_HANDOFF=0; review posted without starting a model turn.";
				pi.sendMessage(
					{
						customType: "second-opinion",
						content:
							`A second opinion was requested from **${reviewer}** — verdict: **${verdict}**.\n\n` +
							`${result.body}\n\n` +
							"---\n" +
							followUp,
						display: true,
						attribution: "user",
					},
					{ triggerTurn: autoHandoff },
				);
				ctx.ui?.notify(
					autoHandoff
						? `Second opinion: ${verdict} (${reviewer}) — handing to the model`
						: `Second opinion: ${verdict} (${reviewer}) — review posted`,
					"info",
				);
			} catch (err) {
				ctx.ui?.notify(`Second opinion failed: ${String(err instanceof Error ? err.message : err)}`, "error");
			}
		},
	});
}
