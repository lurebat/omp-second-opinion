# omp-second-opinion

An **independent, cross-family adversarial second-opinion review** tool for
[oh-my-pi](https://github.com/can1357/oh-my-pi), packaged as a runtime
extension. It is an **extension-compatible reimplementation** of the built-in
`second_opinion` tool from
[PR #1918](https://github.com/can1357/oh-my-pi/pull/1918) — the user-facing
behavior and verdict contract match, but the internals are emulated because it
is built entirely against the **public extension API** plus runtime-injected SDK
exports. It does **not** depend on any of the internal APIs that PR adds (the
native `secondopinion` model role, `getModelSeries`, the `second_opinion`
telemetry kind, `instrumentedCompleteSimple`, etc.), none of which are reachable
from an extension. See "How it differs" below for the exact emulation seams.

## What it does

Sends the **current session branch transcript** to a **different** (ideally
cross-family) model for an independent, adversarial review of your findings,
plan, or code, and returns a structured verdict:

- `SOUND` — no material issues
- `SOUND_WITH_CAVEATS` — works, but with caveats worth addressing
- `FLAWED` — has a real defect that should block

A cross-family reviewer (different model lineage than your session) catches more
because it does not share your blind spots — so the tool prefers one by default.

### Not a subagent

Unlike `task` / `oracle` (which re-run the full agent loop on a same-tier model
from an assignment you write), this is a **one-shot review**: the reviewer model
sees the verbatim transcript + an adversarial system prompt and replies once. It
has **no tools, no agent loop, no MCP/LSP, and no extension recursion** — the
reviewer runs in an ephemeral, in-memory session created via the SDK's
`createAgentSession` with everything disabled and the system prompt replaced.

## Install

Local development install (already active on this machine):

```bash
omp -e /path/to/second-opinion/index.ts
```

User-level auto-load install:

```text
~/.omp/agent/extensions/second-opinion/
  package.json
  index.ts
  core.ts
  prompts.ts
  types.ts
  README.md
  LICENSE
```

GitHub plugin install after publishing the repo:

```bash
omp plugin install github:lurebat/omp-second-opinion#v1.0.0
```

The package manifest must contain `"omp": { "extensions": ["./index.ts"] }`;
runtime plugin discovery skips packages without an `omp`/`pi` manifest.

## Usage

The LLM calls it as the `second_opinion` tool — the review returns as the tool
result, which the model reads and acts on within its own loop (revised plan,
fix, etc.). You can also invoke it yourself:

```
/second-opinion verify the retry/backoff logic handles the 429 path
```

The slash command runs the review, posts progress while it is selecting and
waiting for a reviewer, then **injects the review and starts a turn** so the main
model reads the second opinion, weighs its points, pushes back where warranted,
and presents an updated plan. Set `OMP_SECOND_OPINION_AUTO_HANDOFF=0` to post the
review without starting that follow-up turn.

### Tool parameters

| Param | Default | Meaning |
|---|---|---|
| `focus` | general adversarial review | What the reviewer should pressure-test |
| `model` | configured / auto cross-family | Explicit reviewer selector (`provider/id`, `id`, or substring) |
| `effort` | inherited / `medium` | Reviewer reasoning effort (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`), clamped to model support. Omitted → inherits the configured selector's `:effort` suffix (e.g. `modelRoles.slow` = `…:xhigh`), else `medium` |
| `lookback` | all that fits | Limit to the N most recent rendered transcript turns |

### Reviewer resolution

When `model` is **not** given, the reviewer is chosen in this order, then a
**bounded fallback chain** retries the next candidate if one is unavailable
(some provider/model combinations 4xx even though they appear in the registry):

1. Configured reviewer — `OMP_SECOND_OPINION_MODEL` (headless/ops override), else
   `modelRoles.secondopinion`, else the extension's saved picker choice.
2. Cross-family models, **same provider as the session first** (its auth /
   integrator is known to work), then other providers.
3. The configured `modelRoles.slow` model.
4. Anything available.

An explicit `model` is used as-is with no fallback (errors surface directly).
Saved same-family picker choices are only reused for the session family they were
picked for; after the session family changes, they are treated as stale and the
cross-family default path takes over.

**Family** = the leading series token of the model's canonical id
(`claude-opus-4.8-1m` → `claude`, `gemini-3-pro-preview` → `gemini`,
`gpt-5.5` → `gpt`), so point releases and `1m`/mirror variants fold onto one
lineage. Falls back to the provider when no series token exists.

## Privacy & consent

This tool forwards your **full conversation transcript — including tool outputs
and any file contents it contains** — to another model, possibly a different
vendor than your session model.

- Interactive sessions show a **one-time data-disclosure confirm** before the
  first review; the decision is persisted.
- Headless / print / RPC sessions treat use as consent (nothing is persisted).
- Set `OMP_SECOND_OPINION_CONSENT=1` to pre-consent (e.g. CI).

On the first interactive run (and whenever the session/reviewer family changes)
a **reviewer picker** is offered; the choice is saved as the default and
same-family picks are flagged as weaker.

## Configuration

| Mechanism | Effect |
|---|---|
| `OMP_SECOND_OPINION_MODEL` | Default reviewer selector (headless/ops override) |
| `OMP_SECOND_OPINION_CONSENT=1` | Pre-grant transcript-sharing consent |
| `OMP_SECOND_OPINION_TIMEOUT_SECONDS` / `OMP_SECOND_OPINION_TIMEOUT_MS` | Reviewer request timeout (default: 180s) |
| `OMP_SECOND_OPINION_AUTO_HANDOFF=0` | Slash command posts the review without triggering the main model turn |
| `modelRoles.secondopinion` | Native model role read as the configured reviewer when present |
| `modelRoles.slow` | Used as a fallback reviewer and effort-suffix source |
| `<agentDir>/second-opinion.json` | Persisted `consented` / `reviewer` / `fingerprint` |

## Files

- `index.ts` — orchestration: config, reviewer execution, consent/picker, registration
- `core.ts` — pure logic: transcript rendering, verdict parsing, family/selector/ordering, effort clamp
- `prompts.ts` — reviewer system prompt + tool description
- `types.ts` — narrow structural types for the injected runtime surface

## How it differs from the built-in PR

Because an extension only has the public surface, a few internals are emulated:

- **No native `secondopinion` role / `priority.json`** — the role is read if the
  user set one, but resolution is structural (cross-family-by-default) and lives
  in `core.ts`.
- **`getModelSeries` is re-implemented** locally as `modelFamily()` over the
  canonical id from `modelRegistry.getCanonicalId()`.
- **One-shot completion uses `createAgentSession`** (a tool-less, in-memory
  ephemeral session, MCP/LSP/extension-discovery disabled, system prompt
  replaced) instead of the internal `instrumentedCompleteSimple`; there is no
  oneshot telemetry kind. Verified empirically that the inner reviewer exposes
  no tools and fires zero tool events even when prompted to run a shell command.
- **The structured verdict is parsed from prose** rather than a forced
  `submit_review` tool call: `parseVerdict()` accepts only the final standalone
  `Verdict: …` line as a strong signal, then falls back to a severity-ordered
  keyword scan when no final verdict line exists.
- **Effort suffix is honored.** A configured selector like
  `…:minimal` or `…:xhigh` carries its reasoning level through to the reviewer
  (the explicit `effort` param still overrides); it is not silently dropped.
- **State persists to `<agentDir>/second-opinion.json`** (arbitrary `settings`
  keys are schema-validated and rejected for non-built-in keys), written via a
  same-directory temp file + rename so readers never see a partial final file,
  and tolerant of a missing/corrupt file. There is no cross-process merge/lock;
  last writer wins, which is acceptable for this small local preference file.
  All `getModelRole(...)` reads are guarded so unknown roles never throw on
  older builds.

## Publishing checklist

1. Create a GitHub repository containing the files listed above.
2. Push a tag, e.g. `v1.0.0`.
3. Install-test from the tag:

   ```bash
   omp plugin install github:lurebat/omp-second-opinion#v1.0.0
   ```

4. Keep the MIT license file in the repo; the extension adapts MIT-licensed
   upstream behavior from oh-my-pi PR #1918.
