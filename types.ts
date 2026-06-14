// Narrow structural types for the parts of the oh-my-pi runtime this extension
// touches. Everything is reached through the injected `pi` / `ctx` objects — no
// bare imports of internal packages (those do not resolve inside the compiled
// binary's extension loader). Shapes were confirmed empirically against omp
// 15.x via runtime probes.

/** Thinking effort levels accepted by `createAgentSession`. */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

/** Reviewer reasoning-effort parameter exposed to the model. */
export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** A resolved model entry from `ModelRegistry.getAvailable()`. */
export interface ModelLike {
	id: string;
	name?: string;
	provider: string;
	reasoning?: boolean;
	thinking?: { efforts?: string[] };
}

export interface ModelRegistryLike {
	getAvailable(): ModelLike[];
	getApiKey(model: ModelLike): Promise<string | undefined>;
	getCanonicalId(model: ModelLike): string | undefined;
	authStorage?: unknown;
}

/** A single message-content block (text / tool call / tool result / etc.). */
export interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
}

export interface MessageLike {
	role?: string;
	content?: unknown;
	toolName?: string;
	stopReason?: string;
	errorMessage?: string;
}

/** A persisted session-history entry as returned by `SessionManager.getBranch()`. */
export interface SessionEntry {
	type: string;
	message?: MessageLike;
	content?: unknown;
	customType?: string;
	summary?: string;
	tokensBefore?: number;
	fromId?: string;
}

export interface SessionManagerLike {
	getBranch(): SessionEntry[];
}

export interface UiSelectOption {
	label: string;
	description?: string;
}

export interface ExtensionUi {
	confirm(title: string, message: string): Promise<boolean>;
	select(
		title: string,
		options: UiSelectOption[],
		opts?: { initialIndex?: number },
	): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warn" | "error"): void;
}

/** Handler / tool-execute context passed by the extension runtime. */
export interface ExtensionContextLike {
	cwd: string;
	hasUI: boolean;
	ui?: ExtensionUi;
	model?: ModelLike;
	modelRegistry?: ModelRegistryLike;
	sessionManager?: SessionManagerLike;
}

/** The live settings singleton (`Settings.instance`). */
export interface SettingsLike {
	getModelRole(role: string): string | undefined;
	getAgentDir?(): string;
}

/** A message-stream event emitted by an `AgentSession`. */
export interface SessionEvent {
	type?: string;
	message?: MessageLike;
	assistantMessageEvent?: { type?: string; delta?: string };
}

export interface InnerSession {
	subscribe(listener: (event: SessionEvent) => void): () => void;
	prompt(text: string, options?: Record<string, unknown>): Promise<unknown>;
	abort?(): void;
	dispose(): Promise<void>;
}

export interface CreateAgentSessionResult {
	session: InnerSession;
}

/** The `@oh-my-pi/pi-coding-agent` package exports surfaced as `pi.pi`. */
export interface PiExports {
	createAgentSession(options: Record<string, unknown>): Promise<CreateAgentSessionResult>;
	SessionManager: { inMemory(): unknown };
	Settings?: { instance?: SettingsLike };
}

/** The injected zod module (`pi.zod`). */
export interface ZodModule {
	object(shape: Record<string, unknown>): ZodType;
	string(): ZodType;
	number(): ZodType;
	enum(values: readonly string[]): ZodType;
}

export interface ZodType {
	optional(): ZodType;
	default(value: unknown): ZodType;
	describe(text: string): ZodType;
	int(): ZodType;
	positive(): ZodType;
	strict(): ZodType;
}

export interface ToolResultContent {
	type: "text";
	text: string;
}

export interface AgentToolResult {
	content: ToolResultContent[];
	details?: Record<string, unknown>;
	isError?: boolean;
}

export interface ToolDefinition {
	name: string;
	label: string;
	description: string;
	summary?: string;
	approval?: "read" | "write" | "always-ask";
	parameters: unknown;
	strict?: boolean;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((result: AgentToolResult) => void) | undefined,
		ctx: ExtensionContextLike,
	): Promise<AgentToolResult>;
}

export interface CommandContextLike extends ExtensionContextLike {
	waitForIdle?(): Promise<void>;
}

export interface ExtensionApi {
	zod: ZodModule;
	pi: PiExports;
	logger?: { info?(msg: string): void; warn?(msg: string): void };
	setLabel(label: string): void;
	registerTool(def: ToolDefinition): void;
	registerCommand(
		name: string,
		def: { description: string; handler: (args: string, ctx: CommandContextLike) => Promise<void> },
	): void;
	sendMessage(
		message: { customType: string; content: string; display?: boolean; attribution?: string },
		options?: { triggerTurn?: boolean; deliverAs?: string },
	): void;
}
