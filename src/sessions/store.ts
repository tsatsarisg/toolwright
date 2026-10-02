import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	decodeSession,
	idPattern,
	type SessionFile,
	sessionSchema,
} from "./schema.ts";

export function newSessionId(): string {
	return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}
export class SessionStore {
	readonly directory: string;
	private readonly legacyDirectory: string;
	constructor(
		readonly workspace: string,
		root = process.env.TOOLWRIGHT_STATE_DIR ??
			path.join(os.homedir(), ".toolwright", "sessions"),
	) {
		this.workspace = realpathSync(workspace);
		this.directory = path.join(
			root,
			createHash("sha256").update(this.workspace).digest("hex").slice(0, 24),
		);
		this.legacyDirectory = path.join(
			root,
			workspace.replace(/[/\\:]/g, "-").replace(/^-+/, "") || "root",
		);
	}
	private file(dir: string, id: string): string {
		if (!idPattern.test(id)) throw new Error("Invalid session ID.");
		return path.join(dir, `${id}.json`);
	}
	async save(session: SessionFile): Promise<void> {
		sessionSchema.parse(session);
		await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
		const target = this.file(this.directory, session.id);
		const temporary = `${target}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, JSON.stringify(session, null, 2), {
				encoding: "utf-8",
				mode: 0o600,
			});
			await fs.rename(temporary, target);
		} finally {
			await fs.unlink(temporary).catch(() => {});
		}
	}
	async load(id: string): Promise<SessionFile | null> {
		for (const dir of [this.directory, this.legacyDirectory]) {
			let raw: string;
			try {
				raw = await fs.readFile(this.file(dir, id), "utf-8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			return decodeSession(raw, id, this.workspace);
		}
		return null;
	}
	async list(): Promise<Array<{ id: string; updatedAt: number }>> {
		const result = new Map<string, number>();
		for (const dir of [this.legacyDirectory, this.directory]) {
			let entries: string[];
			try {
				entries = await fs.readdir(dir);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			for (const entry of entries) {
				const id = entry.replace(/\.json$/, "");
				if (!entry.endsWith(".json") || !idPattern.test(id)) continue;
				const stat = await fs.stat(this.file(dir, id));
				result.set(id, Math.max(result.get(id) ?? 0, stat.mtimeMs));
			}
		}
		return [...result]
			.map(([id, updatedAt]) => ({ id, updatedAt }))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}
	async latest(): Promise<string | null> {
		return (await this.list())[0]?.id ?? null;
	}
}
