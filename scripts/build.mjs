import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// Removed or relocated modules must not survive in the next build.
await rm(new URL("../dist/", import.meta.url), {
	recursive: true,
	force: true,
});
const compiler = spawnSync("tsc", ["-p", "tsconfig.build.json"], {
	cwd: root,
	stdio: "inherit",
});
if (compiler.error) throw compiler.error;
process.exitCode = compiler.status ?? 1;
