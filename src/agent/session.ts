import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelMessage } from "ai";
import { z } from "zod";
import type { CommandResult, FileChange, RunOutcome } from "../types.ts";
import type { ProviderSettings } from "./config.ts";
import { filterCompatibleMessages } from "./system/filterMessages.ts";
import type { Workspace } from "./workspace.ts";

export interface SessionFile {
	version: 1;
	id: string;
	updatedAt: string;
	workspace: string;
	history: ModelMessage[];
	provider?: Pick<
		ProviderSettings,
		"profile" | "provider" | "api" | "baseURL" | "model" | "localOnly"
	>;
	changes: FileChange[];
	commands: CommandResult[];
	initialGitStatus: string;
	outcome?: RunOutcome;
}
const idPattern = /^[a-zA-Z0-9_-]+$/;
const historySchema = z.array(
	z.object({
		role: z.enum(["system", "user", "assistant", "tool"]),
		content: z.union([z.string(), z.array(z.unknown())]),
	}),
);
const sessionSchema = z.object({
	version: z.literal(1),
	id: z.string().regex(idPattern),
	updatedAt: z.string(),
	workspace: z.string(),
	history: historySchema,
	provider: z
		.object({
			profile: z.string(),
			provider: z.enum(["openai", "openai-compatible"]),
			api: z.enum(["responses", "chat-completions"]),
			baseURL: z.string(),
			model: z.string(),
			localOnly: z.boolean(),
		})
		.optional(),
	changes: z.array(
		z.object({
			path: z.string(),
			before: z.string().nullable(),
			after: z.string().nullable(),
		}),
	),
	commands: z.array(
		z.object({
			command: z.string(),
			cwd: z.string(),
			stdout: z.string(),
			stderr: z.string(),
			exitCode: z.number().nullable(),
			timedOut: z.boolean(),
			cancelled: z.boolean(),
			overflowed: z.boolean(),
			durationMs: z.number(),
		}),
	),
	initialGitStatus: z.string(),
	outcome: z
		.object({
			status: z.enum([
				"success",
				"failed",
				"cancelled",
				"limited",
				"approval-blocked",
			]),
			reason: z.string(),
			steps: z.number(),
			totalTokens: z.number(),
			durationMs: z.number(),
		})
		.optional(),
});
export function newSessionId(): string {
	return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}
export class SessionStore {
	readonly directory: string;
	private readonly legacyDirectory: string;
	constructor(
		readonly workspace: string,
		root = process.env.TOOLWRIGHT_STATE_DIR ??
			path.join(os.homedir(), ".toolwright", "sessions"),
	) {
		this.workspace = realpathSync(workspace);
		this.directory = path.join(
			root,
			createHash("sha256").update(this.workspace).digest("hex").slice(0, 24),
		);
		this.legacyDirectory = path.join(
			root,
			workspace.replace(/[/\\:]/g, "-").replace(/^-+/, "") || "root",
		);
	}
	private file(dir: string, id: string): string {
		if (!idPattern.test(id)) throw new Error("Invalid session ID.");
		return path.join(dir, `${id}.json`);
	}
	async save(session: SessionFile): Promise<void> {
		sessionSchema.parse(session);
		await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
		const target = this.file(this.directory, session.id);
		const temporary = `${target}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, JSON.stringify(session, null, 2), {
				encoding: "utf-8",
				mode: 0o600,
			});
			await fs.rename(temporary, target);
		} finally {
			await fs.unlink(temporary).catch(() => {});
		}
	}
	async load(id: string): Promise<SessionFile | null> {
		for (const dir of [this.directory, this.legacyDirectory]) {
			let raw: string;
			try {
				raw = await fs.readFile(this.file(dir, id), "utf-8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			let value: unknown;
			try {
				value = JSON.parse(raw);
			} catch {
				throw new Error("Invalid session JSON. Original file was preserved.");
			}
			const parsed = sessionSchema.safeParse(value);
			if (parsed.success) {
				if (parsed.data.workspace !== this.workspace)
					throw new Error("Session belongs to a different workspace.");
				return {
					...parsed.data,
					history: filterCompatibleMessages(
						parsed.data.history as ModelMessage[],
					),
				};
			}
			const legacy = z
				.object({
					version: z.undefined().optional(),
					id: z.string(),
					updatedAt: z.string(),
					history: historySchema,
				})
				.safeParse(value);
			if (!legacy.success)
				throw new Error(
					"Unsupported or invalid session. Original file was preserved.",
				);
			return {
				version: 1,
				id,
				updatedAt: legacy.data.updatedAt,
				workspace: this.workspace,
				history: filterCompatibleMessages(
					legacy.data.history as ModelMessage[],
				),
				changes: [],
				commands: [],
				initialGitStatus: "",
			};
		}
		return null;
	}
	async list(): Promise<Array<{ id: string; updatedAt: number }>> {
		const result = new Map<string, number>();
		for (const dir of [this.legacyDirectory, this.directory]) {
			let entries: string[];
			try {
				entries = await fs.readdir(dir);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			for (const entry of entries) {
				const id = entry.replace(/\.json$/, "");
				if (!entry.endsWith(".json") || !idPattern.test(id)) continue;
				const stat = await fs.stat(this.file(dir, id));
				result.set(id, Math.max(result.get(id) ?? 0, stat.mtimeMs));
			}
		}
		return [...result]
			.map(([id, updatedAt]) => ({ id, updatedAt }))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}
	async latest(): Promise<string | null> {
		return (await this.list())[0]?.id ?? null;
	}
}
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
export async function saveSession(
	id: string,
	history: ModelMessage[],
): Promise<void> {
	const workspace = await (await import("./workspace.ts")).Workspace.open();
	await new SessionStore(workspace.root).save({
		version: 1,
		id,
		updatedAt: new Date().toISOString(),
		workspace: workspace.root,
		history,
		changes: [],
		commands: [],
		initialGitStatus: "",
	});
}
export async function loadSession(id: string): Promise<ModelMessage[] | null> {
	return (await new SessionStore(process.cwd()).load(id))?.history ?? null;
}
export async function latestSessionId(): Promise<string | null> {
	return new SessionStore(process.cwd()).latest();
}
