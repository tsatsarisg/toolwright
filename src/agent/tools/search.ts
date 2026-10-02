import fs from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { markTool } from "../policy.ts";
import { Workspace } from "../workspace.ts";
import { truncateOutput } from "./truncate.ts";

export function globToRegExp(glob: string): RegExp {
	let pattern = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			i++;
			if (glob[i + 1] === "/") {
				i++;
				pattern += "(?:.*/)?";
			} else pattern += ".*";
		} else if (c === "*") pattern += "[^/]*";
		else if (c === "?") pattern += "[^/]";
		else pattern += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
	}
	return new RegExp(`^${pattern}$`);
}
const SKIP = new Set([
	".git",
	".toolwright",
	"node_modules",
	"dist",
	"build",
	"coverage",
]);
type IgnoreRule = { base: string; regex: RegExp; negate: boolean };
async function ignoreRules(
	dir: string,
	names: string[],
): Promise<IgnoreRule[]> {
	const result: IgnoreRule[] = [];
	for (const name of names) {
		let text: string;
		try {
			text = await fs.readFile(path.join(dir, name), "utf-8");
		} catch {
			continue;
		}
		for (let pattern of text.split("\n").map((line) => line.trim())) {
			if (!pattern || pattern.startsWith("#")) continue;
			const negate = pattern.startsWith("!");
			if (negate) pattern = pattern.slice(1);
			const directory = pattern.endsWith("/");
			pattern = pattern.replace(/^\//, "").replace(/\/$/, "");
			const regex = globToRegExp(pattern);
			const fragment = regex.source.slice(1, -1);
			result.push({
				base: dir,
				negate,
				regex: new RegExp(
					`^${pattern.includes("/") ? "" : "(?:.*/)?"}${fragment}${directory ? "(?:/.*)?" : ""}$`,
				),
			});
		}
	}
	return result;
}
function ignored(file: string, rules: IgnoreRule[]): boolean {
	let skip = false;
	for (const rule of rules)
		if (
			rule.regex.test(path.relative(rule.base, file).split(path.sep).join("/"))
		)
			skip = !rule.negate;
	return skip;
}
async function files(
	workspace: Workspace,
	root: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const custom = await ignoreRules(workspace.root, [".toolwrightignore"]);
	if (workspace.gitRoot) {
		try {
			const listed = await workspace.git(
				[
					"ls-files",
					"--cached",
					"--others",
					"--exclude-standard",
					"-z",
					"--",
					root,
				],
				signal,
			);
			return [
				...new Set(
					listed
						.split("\0")
						.filter(Boolean)
						.map((file) => path.resolve(workspace.root, file)),
				),
			]
				.filter((file) => !ignored(file, custom))
				.slice(0, 20000);
		} catch {
			signal?.throwIfAborted();
		}
	}
	const result: string[] = [];
	async function walk(dir: string, inherited: IgnoreRule[]): Promise<void> {
		signal?.throwIfAborted();
		const rules = [
			...inherited,
			...(await ignoreRules(dir, [".gitignore", ".toolwrightignore"])),
		];
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			signal?.throwIfAborted();
			if (result.length >= 20000) return;
			const file = path.join(dir, entry.name);
			if (SKIP.has(entry.name) || ignored(file, rules)) continue;
			if (entry.isDirectory()) await walk(file, rules);
			else if (entry.isFile()) result.push(file);
		}
	}
	await walk(root, custom);
	return result;
}
export function createSearchTools(workspace?: Workspace) {
	const current = () =>
		workspace ? Promise.resolve(workspace) : Workspace.open();
	return {
		globFiles: markTool(
			tool({
				description:
					"Find workspace files using *, **, ? globs. Honors Git ignore rules and .toolwrightignore. Maximum 200 matches.",
				inputSchema: z.object({
					pattern: z.string(),
					directory: z.string().default("."),
				}),
				execute: async ({ pattern, directory }, options) => {
					const w = await current();
					const root = await w.resolve(directory);
					const regex = globToRegExp(pattern);
					const matches = (await files(w, root, options.abortSignal))
						.map((file) => path.relative(root, file))
						.filter((file) => regex.test(file))
						.sort()
						.slice(0, 200);
					return truncateOutput(matches.join("\n") || "No matching files.");
				},
			}),
			"read",
		),
		searchCode: markTool(
			tool({
				description:
					"Search text with a JavaScript regex, returning path:line:text. Honors ignore rules, size and binary limits. Maximum 200 results.",
				inputSchema: z.object({
					pattern: z.string(),
					directory: z.string().default("."),
					filePattern: z.string().optional(),
				}),
				execute: async ({ pattern, directory, filePattern }, options) => {
					const w = await current();
					const root = await w.resolve(directory);
					const regex = new RegExp(pattern);
					const fileRegex = filePattern ? globToRegExp(filePattern) : undefined;
					const matches: string[] = [];
					for (const file of await files(w, root, options.abortSignal)) {
						options.abortSignal?.throwIfAborted();
						const relative = path.relative(root, file);
						if (fileRegex && !fileRegex.test(relative)) continue;
						let text: string;
						try {
							text = await w.read(file, options.abortSignal);
						} catch {
							options.abortSignal?.throwIfAborted();
							continue;
						}
						for (const [index, line] of text.split("\n").entries()) {
							if (regex.test(line))
								matches.push(`${relative}:${index + 1}: ${line.trim()}`);
							if (matches.length >= 200)
								return truncateOutput(matches.join("\n"));
						}
					}
					return truncateOutput(matches.join("\n") || "No matches.");
				},
			}),
			"read",
		),
	};
}
export const { globFiles, searchCode } = createSearchTools();
