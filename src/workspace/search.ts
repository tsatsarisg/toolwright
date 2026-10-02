import fs from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "./workspace.ts";

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
export async function findWorkspaceFiles(
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
