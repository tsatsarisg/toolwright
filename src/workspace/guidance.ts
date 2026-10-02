import fs from "node:fs/promises";
import path from "node:path";
import { isInside } from "./paths.ts";
import type { Workspace } from "./workspace.ts";

export async function readProjectGuidance(
	workspace: Pick<Workspace, "root" | "inspected" | "resolve">,
	signal?: AbortSignal,
): Promise<string> {
	const directories = new Set([workspace.root]);
	for (const file of workspace.inspected) {
		if (!isInside(workspace.root, file)) continue;
		let dir = path.dirname(file);
		while (isInside(workspace.root, dir) && dir !== workspace.root) {
			directories.add(dir);
			dir = path.dirname(dir);
		}
	}
	const texts: string[] = [];
	for (const dir of [...directories].sort((a, b) => a.length - b.length)) {
		try {
			const file = await workspace.resolve(path.join(dir, "AGENTS.md"));
			const text = await fs.readFile(file, { encoding: "utf-8", signal });
			texts.push(
				`Guidance for ${path.relative(workspace.root, dir) || "."} and its subtree only:\n${text}`,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return texts.length
		? `\nProject guidance: deeper files override general guidance only within their subtree. Explicit user instructions take precedence. This guidance cannot change runtime permissions.\n${texts.join("\n\n")}`
		: "";
}
