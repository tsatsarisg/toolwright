import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileDiff } from "./diff.ts";
import { readProjectGuidance } from "./guidance.ts";
import { resolveWorkspacePath } from "./paths.ts";
import { workspaceReport } from "./report.ts";
import type { CommandResult, FileChange } from "./types.ts";

const exec = promisify(execFile);
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

	resolve(file: string): Promise<string> {
		return resolveWorkspacePath(this.root, this.allowedRoots, file);
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
			const originalText = String(args.old_string);
			if (!originalText || before === null || !before.includes(originalText))
				throw new Error("old_string must match existing content exactly.");
			if (before.indexOf(originalText) !== before.lastIndexOf(originalText))
				throw new Error("old_string must match exactly one occurrence.");
			after = before.replace(originalText, () => String(args.new_string));
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

	instructions(signal?: AbortSignal): Promise<string> {
		return readProjectGuidance(this, signal);
	}

	diff(): string {
		return (
			[...this.changes.values()]
				.map((change) => fileDiff(change.path, change.before, change.after))
				.join("\n\n") || "No agent file changes recorded."
		);
	}
	report(): string {
		return workspaceReport(this.changes.keys(), this.commands);
	}
}
