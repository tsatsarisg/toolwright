import type { ModelMessage } from "ai";
import { z } from "zod";
import { filterCompatibleMessages } from "../agent/history/filterMessages.ts";
import type { RunOutcome } from "../agent/types.ts";
import type { ProviderSettings } from "../config/types.ts";
import type { CommandResult, FileChange } from "../workspace/types.ts";

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
export const idPattern = /^[a-zA-Z0-9_-]+$/;
const historySchema = z.array(
	z.object({
		role: z.enum(["system", "user", "assistant", "tool"]),
		content: z.union([z.string(), z.array(z.unknown())]),
	}),
);
export const sessionSchema = z.object({
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

export function decodeSession(
	raw: string,
	id: string,
	workspace: string,
): SessionFile {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("Invalid session JSON. Original file was preserved.");
	}
	const parsed = sessionSchema.safeParse(value);
	if (parsed.success) {
		if (parsed.data.workspace !== workspace)
			throw new Error("Session belongs to a different workspace.");
		return {
			...parsed.data,
			history: filterCompatibleMessages(parsed.data.history as ModelMessage[]),
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
		workspace: workspace,
		history: filterCompatibleMessages(legacy.data.history as ModelMessage[]),
		changes: [],
		commands: [],
		initialGitStatus: "",
	};
}
