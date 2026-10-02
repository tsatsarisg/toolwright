import type { ToolSet } from "ai";
import type { Workspace } from "./workspace.ts";

export type PermissionMode = "plan" | "edit";
export type ToolKind = "read" | "write" | "delete" | "shell" | "network";
const metadata = new WeakMap<object, ToolKind>();
export function markTool<T extends object>(definition: T, kind: ToolKind): T {
	metadata.set(definition, kind);
	return definition;
}
export interface ApprovalDetails {
	preview?: string;
	grantKey: string;
	destructive: boolean;
	kind: ToolKind;
}

export class ExecutionPolicy {
	private readonly grants = new Set<string>();
	constructor(public mode: PermissionMode = "edit") {}
	grant(details: ApprovalDetails): void {
		if (!details.destructive) this.grants.add(details.grantKey);
	}
	async decide(
		name: string,
		args: Record<string, unknown>,
		tools: ToolSet,
		workspace?: Workspace,
	): Promise<{ decision: "allow" | "ask" | "deny"; details: ApprovalDetails }> {
		const definition = tools[name];
		const kind = definition ? (metadata.get(definition) ?? "shell") : "shell";
		const target =
			workspace && typeof args.path === "string"
				? await workspace.resolve(args.path)
				: undefined;
		const destructive =
			kind === "delete" ||
			(target !== undefined &&
				workspace !== undefined &&
				!target.startsWith(`${workspace.root}/`));
		const grantKey = JSON.stringify([
			workspace?.root,
			name,
			target ?? args.command ?? args,
		]);
		const details = { grantKey, destructive, kind };
		if (!definition || (this.mode === "plan" && kind !== "read"))
			return { decision: "deny", details };
		return {
			decision:
				kind === "read" || (!destructive && this.grants.has(grantKey))
					? "allow"
					: "ask",
			details,
		};
	}
}
