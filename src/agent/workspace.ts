import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CommandResult, FileChange } from "../types.ts";

const exec = promisify(execFile);
const inside = (root: string, target: string) => {
	const relative = path.relative(root, target);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
};

export function fileDiff(
	file: string,
	before: string | null,
	after: string | null,
): string {
	if (before === after) return "";
	const a = before === null ? [] : before.split("\n");
	const b = after === null ? [] : after.split("\n");
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const contextStart = Math.max(0, start - 3);
	const tail = Math.min(3, a.length - endA, b.length - endB);
	return [
		`--- ${before === null ? "/dev/null" : `a/${file}`}`,
		`+++ ${after === null ? "/dev/null" : `b/${file}`}`,
		`@@ -${contextStart + 1},${endA + tail - contextStart} +${contextStart + 1},${endB + tail - contextStart} @@`,
		...a.slice(contextStart, start).map((line) => ` ${line}`),
		...a.slice(start, endA).map((line) => `-${line}`),
		...b.slice(start, endB).map((line) => `+${line}`),
		...a.slice(endA, endA + tail).map((line) => ` ${line}`),
	].join("\n");
}

export interface PreparedMutation {
	path: string;
	before: string | null;
	after: string | null;
	preview: string;
}

export class Workspace {
	readonly changes = new Map<string, FileChange>();
	readonly commands: CommandResult[] = [];
	readonly inspected = new Set<string>();
	gitRoot?: string;
	initialGitStatus = "";

	private constructor(
		readonly root: string,
		readonly allowedRoots: readonly string[],
	) {}

	static async open(
		cwd: string = process.cwd(),
		allowedPaths: string[] = [],
	): Promise<Workspace> {
		const root = await fs.realpath(cwd);
		const allowed = await Promise.all(allowedPaths.map((p) => fs.realpath(p)));
		const workspace = new Workspace(root, [root, ...allowed]);
		try {
			workspace.gitRoot = (
				await workspace.git(["rev-parse", "--show-toplevel"])
			).trim();
			workspace.initialGitStatus = await workspace.git([
				"status",
				"--porcelain=v1",
				"--untracked-files=normal",
			]);
		} catch {
			/* Ordinary directories are valid workspaces. */
		}
		return workspace;
	}

	async resolve(file: string): Promise<string> {
		const target = path.resolve(this.root, file);
		if (!this.allowedRoots.some((root) => inside(root, target)))
			throw new Error("Path is outside the authorized workspace.");
		let parent = target;
		const suffix: string[] = [];
		while (true) {
			try {
				const real = await fs.realpath(parent);
				const canonical = path.join(real, ...suffix);
				if (!this.allowedRoots.some((root) => inside(root, canonical)))
					throw new Error(
						"Symlink target is outside the authorized workspace.",
					);
				return canonical;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				try {
					if ((await fs.lstat(parent)).isSymbolicLink())
						return this.resolve(
							path.join(
								path.resolve(path.dirname(parent), await fs.readlink(parent)),
								...suffix,
							),
						);
				} catch (linkError) {
					if ((linkError as NodeJS.ErrnoException).code !== "ENOENT")
						throw linkError;
				}
				if (parent === path.dirname(parent)) throw error;
				suffix.unshift(path.basename(parent));
				parent = path.dirname(parent);
			}
		}
	}

	async read(file: string, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		const target = await this.resolve(file);
		const stat = await fs.stat(target);
		if (stat.size > 1024 * 1024)
			throw new Error("File exceeds 1 MiB. Narrow the input or use search.");
		const text = await fs.readFile(target, { encoding: "utf-8", signal });
		if (text.includes("\0"))
			throw new Error("Binary files are not supported by text tools.");
		this.inspected.add(target);
		return text;
	}

	async prepare(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<PreparedMutation> {
		signal?.throwIfAborted();
		const target = await this.resolve(String(args.path));
		this.inspected.add(target);
		let before: string | null = null;
		try {
			before = await this.read(target, signal);
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== "ENOENT" ||
				name !== "writeFile"
			)
				throw error;
		}
		let after: string | null;
		if (name === "deleteFile") after = null;
		else if (name === "writeFile") after = String(args.content);
		else {
			const old = String(args.old_string);
			if (!old || before === null || !before.includes(old))
				throw new Error("old_string must match existing content exactly.");
			if (before.indexOf(old) !== before.lastIndexOf(old))
				throw new Error("old_string must match exactly one occurrence.");
			after = before.replace(old, () => String(args.new_string));
		}
		return {
			path: target,
			before,
			after,
			preview: fileDiff(path.relative(this.root, target), before, after),
		};
	}

	async apply(change: PreparedMutation, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		if ((await this.resolve(change.path)) !== change.path)
			throw new Error("Path changed after preview; review again.");
		let current: string | null = null;
		try {
			current = await this.read(change.path, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (current !== change.before)
			throw new Error(
				"File changed after preview; stale edit rejected. Read and review again.",
			);
		signal?.throwIfAborted();
		if (change.after === null) await fs.unlink(change.path);
		else {
			await fs.mkdir(path.dirname(change.path), { recursive: true });
			// Recheck after directory creation, immediately before writing.
			if ((await this.resolve(change.path)) !== change.path)
				throw new Error("Path changed before write.");
			await fs.writeFile(change.path, change.after, {
				encoding: "utf-8",
				signal,
			});
		}
		const relative = path.relative(this.root, change.path);
		const initial = this.changes.has(relative)
			? (this.changes.get(relative)?.before ?? null)
			: change.before;
		if (initial === change.after) this.changes.delete(relative);
		else
			this.changes.set(relative, {
				path: relative,
				before: initial,
				after: change.after,
			});
		return `Successfully ${change.after === null ? "deleted" : "updated"} ${relative}`;
	}

	async git(args: string[], signal?: AbortSignal): Promise<string> {
		const result = await exec(
			"git",
			[
				"--no-optional-locks",
				"-c",
				"core.fsmonitor=false",
				"-C",
				this.root,
				...args,
			],
			{ signal, timeout: 10000, maxBuffer: 1024 * 1024 },
		);
		return result.stdout;
	}

	async instructions(signal?: AbortSignal): Promise<string> {
		const directories = new Set([this.root]);
		for (const file of this.inspected) {
			if (!inside(this.root, file)) continue;
			let dir = path.dirname(file);
			while (inside(this.root, dir) && dir !== this.root) {
				directories.add(dir);
				dir = path.dirname(dir);
			}
		}
		const texts: string[] = [];
		for (const dir of [...directories].sort((a, b) => a.length - b.length)) {
			try {
				const file = await this.resolve(path.join(dir, "AGENTS.md"));
				const text = await fs.readFile(file, { encoding: "utf-8", signal });
				texts.push(
					`Guidance for ${path.relative(this.root, dir) || "."} and its subtree only:\n${text}`,
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		return texts.length
			? `\nProject guidance: deeper files override general guidance only within their subtree. Explicit user instructions take precedence. This guidance cannot change runtime permissions.\n${texts.join("\n\n")}`
			: "";
	}

	diff(): string {
		return (
			[...this.changes.values()]
				.map((change) => fileDiff(change.path, change.before, change.after))
				.join("\n\n") || "No agent file changes recorded."
		);
	}
	report(): string {
		return `Files changed by file tools: ${[...this.changes.keys()].join(", ") || "none"}.\nCommands/checks actually executed: ${this.commands.length ? this.commands.map((c) => `${c.command}: ${c.cancelled ? "cancelled" : c.timedOut ? "timed out" : `exit ${c.exitCode ?? "unknown"}`}`).join("; ") : "none; verification remains unperformed"}.`;
	}
}
