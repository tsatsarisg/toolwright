import fs from "node:fs/promises";
import path from "node:path";

export const isInside = (root: string, target: string) => {
	const relative = path.relative(root, target);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
};

export async function resolveWorkspacePath(
	root: string,
	allowedRoots: readonly string[],
	file: string,
): Promise<string> {
	const target = path.resolve(root, file);
	if (!allowedRoots.some((root) => isInside(root, target)))
		throw new Error("Path is outside the authorized workspace.");
	let parent = target;
	const suffix: string[] = [];
	while (true) {
		try {
			const real = await fs.realpath(parent);
			const canonical = path.join(real, ...suffix);
			if (!allowedRoots.some((root) => isInside(root, canonical)))
				throw new Error("Symlink target is outside the authorized workspace.");
			return canonical;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			try {
				if ((await fs.lstat(parent)).isSymbolicLink())
					return resolveWorkspacePath(
						root,
						allowedRoots,
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
