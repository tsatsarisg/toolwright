import type { ModelMessage } from "ai";
import { filterCompatibleMessages } from "../agent/history/filterMessages.ts";
import type { RunOutcome } from "../agent/types.ts";
import type { ProviderSettings } from "../config/types.ts";
import type { Workspace } from "../workspace/workspace.ts";
import type { SessionFile } from "./schema.ts";

export function sessionSnapshot(
	id: string,
	history: ModelMessage[],
	workspace: Workspace,
	settings: ProviderSettings,
	outcome?: RunOutcome,
): SessionFile {
	const { profile, provider, api, baseURL, model, localOnly } = settings;
	return {
		version: 1,
		id,
		updatedAt: new Date().toISOString(),
		workspace: workspace.root,
		history: filterCompatibleMessages(history),
		provider: { profile, provider, api, baseURL, model, localOnly },
		changes: [...workspace.changes.values()],
		commands: [...workspace.commands],
		initialGitStatus: workspace.initialGitStatus,
		outcome,
	};
}
export function restoreWorkspace(
	workspace: Workspace,
	session: SessionFile,
): void {
	for (const change of session.changes)
		workspace.changes.set(change.path, change);
	workspace.commands.push(...session.commands);
	workspace.initialGitStatus = session.initialGitStatus;
}
