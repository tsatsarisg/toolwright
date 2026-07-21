import fs from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { truncateOutput } from "./truncate.ts";

/**
 * Generous cap for file reads (~16k tokens). Real source files pass through
 * untouched; a giant log or minified bundle gets capped so it can't blow the
 * context window.
 */
const MAX_FILE_CHARS = 60_000;

/**
 * By default every file tool is confined to the current working directory —
 * the approval prompt is the only other gate, and confining the blast radius
 * of a reflexive "Yes" to the project directory is cheap insurance. Set
 * TOOLWRIGHT_ALLOW_UNSAFE_PATHS=1 to allow reads/writes anywhere the OS user can.
 */
const ALLOW_OUTSIDE_CWD = process.env.TOOLWRIGHT_ALLOW_UNSAFE_PATHS === "1";

class PathConfinementError extends Error {}

function resolveSafePath(filePath: string): string {
	const resolved = path.resolve(process.cwd(), filePath);
	if (ALLOW_OUTSIDE_CWD) return resolved;

	const rel = path.relative(process.cwd(), resolved);
	const isInside =
		rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
	if (!isInside) {
		throw new PathConfinementError(
			`Refusing to access "${filePath}" — it resolves outside the working directory. ` +
				`Set TOOLWRIGHT_ALLOW_UNSAFE_PATHS=1 to allow paths outside the project.`,
		);
	}
	return resolved;
}

/** Shared error formatting for the four fs-backed tools below. */
function formatFsError(
	error: unknown,
	target: string,
	subject: string,
	verb: string,
): string {
	if (error instanceof PathConfinementError) {
		return error.message;
	}
	const err = error as NodeJS.ErrnoException;
	if (err.code === "ENOENT") {
		return `Error: ${subject} not found: ${target}`;
	}
	return `Error ${verb}: ${err.message}`;
}

/**
 * Read file contents
 */
export const readFile = tool({
	description:
		"Read the contents of a file at the specified path. Use this to examine file contents.",
	inputSchema: z.object({
		path: z.string().describe("The path to the file to read"),
	}),
	execute: async ({ path: filePath }: { path: string }) => {
		try {
			const content = await fs.readFile(resolveSafePath(filePath), "utf-8");
			return truncateOutput(content, MAX_FILE_CHARS);
		} catch (error) {
			return formatFsError(error, filePath, "File", "reading file");
		}
	},
});

/**
 * Write content to a file
 */
export const writeFile = tool({
	description:
		"Write content to a file at the specified path. Creates the file if it doesn't exist, overwrites if it does. For an existing file, prefer editFile for a small, targeted change.",
	inputSchema: z.object({
		path: z.string().describe("The path to the file to write"),
		content: z.string().describe("The content to write to the file"),
	}),
	execute: async ({
		path: filePath,
		content,
	}: {
		path: string;
		content: string;
	}) => {
		try {
			const target = resolveSafePath(filePath);
			// Create parent directories if they don't exist
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, content, "utf-8");
			return `Successfully wrote ${content.length} characters to ${filePath}`;
		} catch (error) {
			return formatFsError(error, filePath, "File", "writing file");
		}
	},
});

/**
 * Replace one exact, unique occurrence of a string in an existing file.
 *
 * Unlike writeFile, this doesn't require the model to re-send the whole file
 * — it only needs enough surrounding context for old_string to be unambiguous.
 */
export const editFile = tool({
	description:
		"Replace an exact, unique snippet of text in an existing file. old_string must match the file's current contents exactly (including whitespace/indentation) and must appear exactly once — include enough surrounding context to make it unique. Prefer this over writeFile for any change to an existing file.",
	inputSchema: z.object({
		path: z.string().describe("The path to the file to edit"),
		old_string: z
			.string()
			.describe("The exact, unique existing text to replace"),
		new_string: z.string().describe("The text to replace it with"),
	}),
	execute: async ({
		path: filePath,
		old_string,
		new_string,
	}: {
		path: string;
		old_string: string;
		new_string: string;
	}) => {
		if (old_string.length === 0) {
			return "Error: old_string must not be empty — use writeFile to create a new file.";
		}
		try {
			const target = resolveSafePath(filePath);
			const content = await fs.readFile(target, "utf-8");

			const firstIndex = content.indexOf(old_string);
			if (firstIndex === -1) {
				return `Error: old_string not found in ${filePath}. It must match the file's current contents exactly — read the file again if you're unsure.`;
			}
			if (content.indexOf(old_string, firstIndex + 1) !== -1) {
				return `Error: old_string appears more than once in ${filePath}. Include more surrounding context so it matches exactly one location.`;
			}

			const updated =
				content.slice(0, firstIndex) +
				new_string +
				content.slice(firstIndex + old_string.length);
			await fs.writeFile(target, updated, "utf-8");
			return `Successfully edited ${filePath} (replaced ${old_string.length} chars with ${new_string.length}).`;
		} catch (error) {
			return formatFsError(error, filePath, "File", "editing file");
		}
	},
});

/**
 * List files in a directory
 */
export const listFiles = tool({
	description:
		"List all files and directories in the specified directory path.",
	inputSchema: z.object({
		directory: z
			.string()
			.describe("The directory path to list contents of")
			.default("."),
	}),
	execute: async ({ directory }: { directory: string }) => {
		try {
			const entries = await fs.readdir(resolveSafePath(directory), {
				withFileTypes: true,
			});
			const items = entries.map((entry) => {
				const type = entry.isDirectory() ? "[dir]" : "[file]";
				return `${type} ${entry.name}`;
			});
			return items.length > 0
				? items.join("\n")
				: `Directory ${directory} is empty`;
		} catch (error) {
			return formatFsError(error, directory, "Directory", "listing directory");
		}
	},
});

/**
 * Delete a file
 */
export const deleteFile = tool({
	description:
		"Delete a file at the specified path. Use with caution as this is irreversible.",
	inputSchema: z.object({
		path: z.string().describe("The path to the file to delete"),
	}),
	execute: async ({ path: filePath }: { path: string }) => {
		try {
			await fs.unlink(resolveSafePath(filePath));
			return `Successfully deleted ${filePath}`;
		} catch (error) {
			return formatFsError(error, filePath, "File", "deleting file");
		}
	},
});
