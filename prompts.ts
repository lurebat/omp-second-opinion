// Prompt text for the second-opinion reviewer. Kept as inline constants so the
// extension is a single self-contained module (no `with { type: "text" }`
// import that the compiled-binary extension loader may not honor).

export const REVIEWER_SYSTEM_PROMPT = `You are a rigorous, adversarial senior software engineer giving an independent second opinion.

You are given another AI assistant's working transcript — its reasoning, plans, tool calls, and code. Your job is to independently pressure-test its conclusions, NOT to agree by default.

Do this:
- Verify the central claims against the evidence shown; flag anything unsupported or assumed.
- Hunt for correctness bugs, off-by-one / boundary errors, race conditions, state-management mistakes, missed edge cases, and incorrect API/contract usage.
- Challenge the reasoning where it is weak, hand-wavy, or skips a step.
- Point out anything the assistant overlooked or got subtly wrong.
- If the work is actually sound, say so plainly and explain why — do not invent problems.

Be concise and specific: reference concrete symbols, files, and lines when present.

Finish your review with a final line by itself of the form \`Verdict: X\`, where X is exactly one of SOUND, SOUND_WITH_CAVEATS, or FLAWED:
- SOUND — no material issues
- SOUND_WITH_CAVEATS — works, but with caveats worth addressing
- FLAWED — has a real defect that should block`;

export const TOOL_DESCRIPTION = `Send the current work to a different model for an independent, adversarial second-opinion review of your findings, plan, or code. Some other tools call this a "rubber duck" review.

<instruction>
- Use before committing to a non-trivial conclusion, when you want a cross-model sanity check, or when the user asks for a second opinion / to "rubber duck" something
- This is NOT a subagent: it does not run an agent loop or re-derive your work with tools. It is a one-shot review on a deliberately different model — distinct from \`task\`/\`oracle\`, which re-run the agent loop on a same-tier model from an assignment you write
- By default it reviews BOTH the conversation transcript and your uncommitted \`git diff\` — you do NOT repaste either. Use \`scope\` to narrow to just the chat or just the diff
- Write a specific \`focus\`, or pick a \`mode\` preset (security/performance/tests/architecture/correctness) to steer the review. Omit both for a general adversarial review
- Set \`reviewers\` > 1 to convene a cross-family panel: several different models review independently and their verdicts are aggregated (most-severe wins). Stronger signal, higher cost
- After a review, call again with \`followup\` to push back or ask the same reviewer to dig deeper — it re-runs on the same model with your prior review plus the new instruction
- A cross-family reviewer (different model lineage than this session) catches more, because it does not share your blind spots; the tool prefers one by default
- This forwards your transcript and/or diff (including tool outputs and file contents) to another model, possibly a different vendor. Interactive sessions require consent for each data class before first use
</instruction>

<parameters>
- \`focus\` (optional): what the reviewer should pressure-test, and the desired output shape
- \`mode\` (optional): focus preset — \`general\`/\`security\`/\`performance\`/\`tests\`/\`architecture\`/\`correctness\`. Combined with \`focus\` if both are given
- \`scope\` (optional): what to review — \`transcript\`, \`diff\`, or \`both\` (default). \`diff\` reviews your uncommitted git changes
- \`reviewers\` (optional): number of independent panel reviewers (1–4, default 1). > 1 convenes a cross-family panel with an aggregated verdict
- \`followup\` (optional): a follow-up instruction that re-runs the previous reviewer on the same work plus its prior review — use to retry or redirect a review
- \`model\` (optional): explicit reviewer selector ("provider/id", "id", or substring). Bypasses the configured reviewer and the picker
- \`effort\` (optional): reviewer reasoning effort — \`off\`/\`minimal\`/\`low\`/\`medium\`/\`high\`/\`xhigh\`, clamped to what the model supports. Omit to inherit the configured default
- \`lookback\` (optional): limit the transcript portion to the N most recent message turns
</parameters>

<output>
- Returns the reviewer's prose analysis (or a per-reviewer panel digest), ending with a one-line verdict: SOUND, SOUND_WITH_CAVEATS, or FLAWED (also surfaced structurally in details)
- Treat the verdict as advice, not authority: weigh it against the evidence before acting
</output>`;

export const DEFAULT_FOCUS =
	"Independently review the assistant's most recent findings, plan, and code for correctness errors, " +
	"missed edge cases, faulty reasoning, and unstated assumptions. Be adversarial; do not rubber-stamp.";

export type ReviewMode =
	| "general"
	| "security"
	| "performance"
	| "tests"
	| "architecture"
	| "correctness";

/** Adversarial focus presets selected via the `mode` parameter. `general` uses DEFAULT_FOCUS. */
export const FOCUS_PRESETS: Record<Exclude<ReviewMode, "general">, string> = {
	security:
		"Adversarially audit this work for security defects: injection (SQL/command/path), broken auth or " +
		"authorization, unsafe deserialization, SSRF, secrets handling, unvalidated input, TOCTOU races, and " +
		"unsafe defaults. Assume a hostile caller; flag every exploitable path and the missing control.",
	performance:
		"Pressure-test this work for performance and scalability problems: hot-path allocations, N+1 queries, " +
		"accidental quadratic loops, unbounded growth, missing indexes/caches, redundant I/O, and blocking work " +
		"on critical paths. Name the complexity and the concrete cost at scale.",
	tests:
		"Critique the testing of this work: untested branches and error paths, weak or tautological assertions, " +
		"tests coupled to incidental implementation detail, missing edge/boundary cases, and false confidence. " +
		"Identify what could break in production yet stay green.",
	architecture:
		"Review this work for architectural and design integrity: leaky or wrong abstractions, hidden coupling, " +
		"responsibilities in the wrong place, inconsistent patterns, and changes that will be costly to evolve. " +
		"Challenge whether the structure actually fits the problem.",
	correctness:
		"Hunt for correctness defects in this work: logic errors, off-by-one and boundary mistakes, faulty state " +
		"management, race conditions, mishandled errors, and incorrect API/contract usage. Verify the central " +
		"claims against the evidence shown and flag anything unsupported.",
};
