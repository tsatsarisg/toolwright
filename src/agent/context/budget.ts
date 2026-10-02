export class TokenBudgetExceeded extends Error {}

export class TokenBudget {
	private usedTokens = 0;
	constructor(private readonly limit: number) {}

	get totalTokens(): number {
		return this.usedTokens;
	}

	get exhausted(): boolean {
		return this.usedTokens >= this.limit;
	}

	recordRequest(tokens: number): void {
		this.usedTokens += tokens;
	}

	recordCompaction(tokens: number): void {
		this.recordRequest(tokens);
		if (this.exhausted) {
			throw new TokenBudgetExceeded(
				"Cumulative token budget reached during compaction.",
			);
		}
	}

	checkCompactionReservation(tokens: number): void {
		if (tokens > this.limit - this.usedTokens) {
			throw new TokenBudgetExceeded(
				"Cumulative token budget cannot fit compaction.",
			);
		}
	}

	outputAllowance(inputTokens: number): number {
		const remaining = this.limit - this.usedTokens - inputTokens;
		if (remaining < 1) {
			throw new TokenBudgetExceeded(
				"Cumulative token budget cannot fit the next request.",
			);
		}
		return remaining;
	}
}
