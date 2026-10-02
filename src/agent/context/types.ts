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
