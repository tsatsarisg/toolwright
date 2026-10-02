import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import type { ProviderSelection } from "../config/types.ts";
import type { ResolvedProvider } from "../providers/resolve.ts";
import type { Workspace } from "../workspace/workspace.ts";
import type { TokenUsageInfo } from "./context/types.ts";
import type {
	ApprovalDetails,
	ExecutionPolicy,
	PermissionMode,
} from "./execution/policy.ts";

export interface AgentCallbacks {
	onToken: (token: string) => void;
	onToolCallStart: (name: string, args: unknown, toolCallId: string) => void;
	onToolCallEnd: (toolCallId: string, result: string) => void;
	onComplete: (response: string) => void;
	onTokenUsage?: (usage: TokenUsageInfo) => void;
	onOutcome?: (outcome: RunOutcome) => void;
	onCheckpoint?: (history: ModelMessage[]) => Promise<void>;
	onCommandOutput?: (text: string) => void;
	onToolApproval: (
		name: string,
		args: unknown,
		details?: ApprovalDetails,
	) => Promise<boolean>;
}

export type OutcomeStatus =
	| "success"
	| "failed"
	| "cancelled"
	| "limited"
	| "approval-blocked";

export interface RunOutcome {
	status: OutcomeStatus;
	reason: string;
	steps: number;
	totalTokens: number;
	durationMs: number;
}

export interface ToolCallInfo {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
}

export interface RunAgentOptions extends ProviderSelection {
	resolvedProvider?: ResolvedProvider;
	languageModel?: LanguageModel;
	tools?: ToolSet;
	systemPrompt?: string;
	telemetry?: boolean;
	workspace?: Workspace;
	policy?: ExecutionPolicy;
	mode?: PermissionMode;
	signal?: AbortSignal;
	maxSteps?: number;
	maxTokens?: number;
	maxTurnMs?: number;
	maxFailures?: number;
}
