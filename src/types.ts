export interface AgentCallbacks {
	onToken: (token: string) => void;
	onToolCallStart: (name: string, args: unknown, toolCallId: string) => void;
	onToolCallEnd: (toolCallId: string, result: string) => void;
	onComplete: (response: string) => void;
	onTokenUsage?: (usage: TokenUsageInfo) => void;
	onOutcome?: (outcome: RunOutcome) => void;
	onCheckpoint?: (history: import("ai").ModelMessage[]) => Promise<void>;
	onCommandOutput?: (text: string) => void;
	onToolApproval: (
		name: string,
		args: unknown,
		details?: import("./agent/policy.ts").ApprovalDetails,
	) => Promise<boolean>;
}

export interface ToolApprovalRequest {
	toolName: string;
	args: unknown;
	resolve: (approved: boolean) => void;
	details?: import("./agent/policy.ts").ApprovalDetails;
}

export interface FileChange {
	path: string;
	before: string | null;
	after: string | null;
}
export interface CommandResult {
	command: string;
	cwd: string;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	cancelled: boolean;
	overflowed: boolean;
	durationMs: number;
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

export interface ModelLimits {
	inputLimit: number;
	outputLimit: number;
	contextWindow: number;
}

export interface TokenUsageInfo {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	contextWindow: number;
	threshold: number;
	percentage: number;
}
