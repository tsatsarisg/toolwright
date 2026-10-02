import type { ApprovalDetails } from "../agent/execution/policy.ts";

export interface ToolApprovalRequest {
	toolName: string;
	args: unknown;
	resolve: (approved: boolean) => void;
	details?: ApprovalDetails;
}
