import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { truncateOutput } from "./truncate.ts";

const IGNORE_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".next",
	".turbo",
	"coverage",
]);

/** A NUL byte never appears in real text; its presence is the standard binary-file heuristic. */
const NUL_CHAR = String.fromCharCode(0);

const REGEX_SPECIAL_CHARS = new Set([
	".",
	"+",
	"^",
	"$",
	"{",
	"}",
	"(",
	")",
	"|",
	"[",
	"]",
	"\\",
]);

/** Hard cap on files visited per call, so a huge tree can't hang the tool. */
const MAX_FILES_VISITED = 20_000;
/** Hard cap on results returned, so a broad pattern can't blow the context window. */
const MAX_RESULTS = 200;

/**
 * Translate a small glob subset (`*`, `**`, `?`) into a RegExp matched
 * against a POSIX-style relative path. Not a full glob implementation —
 * enough for the common "src/**\/*.ts" / "*.json" cases an agent needs.
 */
function globToRegExp(glob: string): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				out += ".*";
				i++;
				if (glob[i + 1] === "/") i++;
			} else {
				out += "[^/]*";
			}
		} else if (c === "?") {
			out += "[^/]";
		} else if (REGEX_SPECIAL_CHARS.has(c)) {
			out += `\\${c}`;
		} else {
			out += c;
		}
	}
	return new RegExp(`^${out}$`);
}

/**
 * Recursively walk `dir`, calling `onFile` for every file (skipping
 * node_modules/.git/build output and dotfiles/dotdirs). `onFile` returning
 * `false` stops the walk early once a caller has enough results.
 */
async function walk(
	dir: string,
	onFile: (filePath: string) => Promise<boolean | undefined>,
	state: { visited: number } = { visited: 0 },
): Promise<boolean> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return true; // unreadable directory — skip it, keep walking siblings
	}

	for (const entry of entries) {
		if (state.visited >= MAX_FILES_VISITED) return false;

		if (entry.isDirectory()) {
			if (entry.name.startsWith(".") || IGNORE_DIRS.has(entry.name)) continue;
			const keepGoing = await walk(path.join(dir, entry.name), onFile, state);
			if (!keepGoing) return false;
		} else if (entry.isFile()) {
			state.visited++;
			const result = await onFile(path.join(dir, entry.name));
			if (result === false) return false;
		}
	}
	return true;
}

/**
 * Recursively find files whose relative path matches a glob pattern.
 */
export const globFiles = tool({
	description:
		"Recursively find files under a directory whose relative path matches a glob pattern (e.g. 'src/**/*.ts', '*.json'). Skips node_modules, .git, and common build output directories. Use this instead of chaining many listFiles calls to explore a codebase.",
	inputSchema: z.object({
		pattern: z
			.string()
			.describe("Glob pattern to match, relative to `directory`"),
		directory: z.string().default(".").describe("Directory to search from"),
	}),
	execute: async ({
		pattern,
		directory,
	}: {
		pattern: string;
		directory: string;
	}) => {
		try {
			const root = path.resolve(directory);
			const regex = globToRegExp(pattern);
			const matches: string[] = [];

			await walk(root, async (filePath) => {
				const rel = path.relative(root, filePath);
				if (regex.test(rel)) matches.push(rel);
				return matches.length < MAX_RESULTS;
			});

			if (matches.length === 0) {
				return `No files matched "${pattern}" under ${directory}`;
			}
			matches.sort();
			const truncatedNotice =
				matches.length >= MAX_RESULTS
					? `\n\n[... stopped at ${MAX_RESULTS} matches, narrow the pattern for more]`
					: "";
			return matches.join("\n") + truncatedNotice;
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			return `Error searching for files: ${err.message}`;
		}
	},
});

/**
 * Recursively grep file contents for a regular expression.
 */
export const searchCode = tool({
	description:
		"Search file contents recursively for a regular expression (JavaScript regex syntax), returning matching lines as 'path:line: text'. Skips node_modules, .git, build output, and binary-looking files. Use this instead of runCommand for grep-style searches — it doesn't need shell approval.",
	inputSchema: z.object({
		pattern: z.string().describe("Regular expression to search for"),
		directory: z.string().default(".").describe("Directory to search from"),
		filePattern: z
			.string()
			.optional()
			.describe(
				"Optional glob to restrict which files are searched, e.g. '*.ts'",
			),
	}),
	execute: async ({
		pattern,
		directory,
		filePattern,
	}: {
		pattern: string;
		directory: string;
		filePattern?: string;
	}) => {
		let regex: RegExp;
		try {
			regex = new RegExp(pattern);
		} catch {
			return `Error: "${pattern}" is not a valid regular expression.`;
		}

		try {
			const root = path.resolve(directory);
			const fileRegex = filePattern ? globToRegExp(filePattern) : null;
			const results: string[] = [];

			await walk(root, async (filePath) => {
				const rel = path.relative(root, filePath);
				if (fileRegex && !fileRegex.test(rel)) return true;

				let content: string;
				try {
					content = await fs.readFile(filePath, "utf-8");
				} catch {
					return true; // unreadable — skip
				}
				if (content.includes(NUL_CHAR)) return true; // binary file — skip

				const lines = content.split("\n");
				for (let i = 0; i < lines.length; i++) {
					if (regex.test(lines[i])) {
						results.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
						if (results.length >= MAX_RESULTS) return false;
					}
				}
				return true;
			});

			if (results.length === 0) {
				return `No matches for "${pattern}" under ${directory}`;
			}
			return truncateOutput(results.join("\n"));
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			return `Error searching file contents: ${err.message}`;
		}
	},
});
