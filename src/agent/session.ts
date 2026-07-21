import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelMessage } from "ai";

const SESSIONS_ROOT = path.join(os.homedir(), ".friday", "sessions");

/**
 * Turn a cwd into a filesystem-safe directory name, so sessions from
 * different projects never collide and nothing gets written into the
 * project directory itself (no need for the user to .gitignore anything).
 */
function projectKey(cwd: string): string {
	return cwd.replace(/[/\\:]/g, "-").replace(/^-+/, "") || "root";
}

function projectSessionsDir(cwd: string = process.cwd()): string {
	return path.join(SESSIONS_ROOT, projectKey(cwd));
}

interface SessionFile {
	id: string;
	updatedAt: string;
	history: ModelMessage[];
}

export function newSessionId(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Persist the full conversation history for a session. Overwrites any prior save for the same id. */
export async function saveSession(
	id: string,
	history: ModelMessage[],
): Promise<void> {
	const dir = projectSessionsDir();
	await fs.mkdir(dir, { recursive: true });
	const file: SessionFile = {
		id,
		updatedAt: new Date().toISOString(),
		history,
	};
	await fs.writeFile(
		path.join(dir, `${id}.json`),
		JSON.stringify(file, null, 2),
		"utf-8",
	);
}

/** Load a session's history by id. Returns null if it doesn't exist or fails to parse. */
export async function loadSession(id: string): Promise<ModelMessage[] | null> {
	try {
		const raw = await fs.readFile(
			path.join(projectSessionsDir(), `${id}.json`),
			"utf-8",
		);
		const parsed = JSON.parse(raw) as SessionFile;
		return parsed.history;
	} catch {
		return null;
	}
}

/** Id of the most recently updated session for the current project, or null if there is none. */
export async function latestSessionId(): Promise<string | null> {
	const dir = projectSessionsDir();
	let entries: string[];
	try {
		entries = (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
	} catch {
		return null;
	}
	if (entries.length === 0) return null;

	const withMtime = await Promise.all(
		entries.map(async (name) => {
			const stat = await fs.stat(path.join(dir, name));
			return { id: name.replace(/\.json$/, ""), mtimeMs: stat.mtimeMs };
		}),
	);
	withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return withMtime[0].id;
}
