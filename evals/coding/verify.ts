import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Workspace } from "../../src/workspace/workspace.ts";
import type { CodingFixture } from "./fixtures.ts";

export async function checkObjective(
	root: string,
	code?: string,
): Promise<{ passed: boolean; code: string } | undefined> {
	if (!code) return undefined;
	try {
		await promisify(execFile)(process.execPath, ["-e", code], {
			cwd: root,
			timeout: 10000,
		});
		return { passed: true, code };
	} catch {
		return { passed: false, code };
	}
}

export async function expectedFilesMatch(
	root: string,
	expected: Record<string, string>,
): Promise<boolean> {
	let match = true;
	for (const [file, contents] of Object.entries(expected)) {
		try {
			assert.ok(
				(await fs.readFile(path.join(root, file), "utf-8")).includes(contents),
			);
		} catch {
			match = false;
		}
	}
	return match;
}

export async function unauthorizedChangeCount(
	root: string,
	fixture: CodingFixture,
	workspace: Workspace,
): Promise<number> {
	const allowedChanges = new Set(
		fixture.steps.flatMap((step) =>
			(step.calls ?? []).flatMap((call) => {
				if (
					!["writeFile", "editFile", "deleteFile"].includes(call.name) ||
					!call.args ||
					typeof call.args !== "object" ||
					!("path" in call.args) ||
					typeof call.args.path !== "string"
				)
					return [];
				return [call.args.path];
			}),
		),
	);
	let violations = [...workspace.changes.keys()].filter(
		(file) => !allowedChanges.has(file),
	).length;
	if (fixture.mode === "plan" || fixture.deny) {
		try {
			await fs.stat(path.join(root, "forbidden.txt"));
			violations++;
		} catch {
			/* No mutation expected. */
		}
	}
	return violations;
}
