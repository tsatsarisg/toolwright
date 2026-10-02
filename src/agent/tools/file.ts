import fs from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { markTool } from "../policy.ts";
import { Workspace } from "../workspace.ts";
import { truncateOutput } from "./truncate.ts";

export function createFileTools(workspace?: Workspace) {
	const current = () =>
		workspace ? Promise.resolve(workspace) : Workspace.open();
	const readFile = markTool(
		tool({
			description:
				"Read a text file with optional 1-based startLine/endLine. Prefer small ranges for large files.",
			inputSchema: z.object({
				path: z.string(),
				startLine: z.number().int().positive().optional(),
				endLine: z.number().int().positive().optional(),
			}),
			execute: async ({ path, startLine, endLine }, options) => {
				const text = await (await current()).read(path, options.abortSignal);
				if (startLine && endLine && endLine < startLine)
					throw new Error("endLine must be at least startLine.");
				const start = (startLine ?? 1) - 1;
				return truncateOutput(
					text
						.split("\n")
						.slice(start, endLine)
						.map((line, i) => `${start + i + 1}: ${line}`)
						.join("\n"),
					12000,
				);
			},
		}),
		"read",
	);
	const writeFile = markTool(
		tool({
			description:
				"Create or replace a text file. Prefer editFile for existing files. A diff is reviewed before writing.",
			inputSchema: z.object({ path: z.string(), content: z.string() }),
			execute: async (args, options) => {
				const w = await current();
				return w.apply(
					await w.prepare("writeFile", args, options.abortSignal),
					options.abortSignal,
				);
			},
		}),
		"write",
	);
	const editFile = markTool(
		tool({
			description:
				"Replace one exact unique occurrence of old_string. Read first; include enough context to match once.",
			inputSchema: z.object({
				path: z.string(),
				old_string: z.string().min(1),
				new_string: z.string(),
			}),
			execute: async (args, options) => {
				const w = await current();
				return w.apply(
					await w.prepare("editFile", args, options.abortSignal),
					options.abortSignal,
				);
			},
		}),
		"write",
	);
	const deleteFile = markTool(
		tool({
			description:
				"Delete a file after reviewing its deletion. Requires specific approval.",
			inputSchema: z.object({ path: z.string() }),
			execute: async (args, options) => {
				const w = await current();
				return w.apply(
					await w.prepare("deleteFile", args, options.abortSignal),
					options.abortSignal,
				);
			},
		}),
		"delete",
	);
	const listFiles = markTool(
		tool({
			description: "List entries in a workspace directory.",
			inputSchema: z.object({ directory: z.string().default(".") }),
			execute: async ({ directory }, options) => {
				options.abortSignal?.throwIfAborted();
				const entries = await fs.readdir(
					await (await current()).resolve(directory),
					{ withFileTypes: true },
				);
				return truncateOutput(
					entries
						.map(
							(entry) =>
								`${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`,
						)
						.join("\n"),
				);
			},
		}),
		"read",
	);
	return { readFile, writeFile, editFile, deleteFile, listFiles };
}
export const { readFile, writeFile, editFile, deleteFile, listFiles } =
	createFileTools();
