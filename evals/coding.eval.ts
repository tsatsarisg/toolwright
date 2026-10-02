import { parseArgs } from "node:util";
import { resolveProvider } from "../src/providers/resolve.ts";
import { codingFixtures } from "./coding/fixtures.ts";
import { runCodingFixture } from "./coding/runFixture.ts";

const { values } = parseArgs({
	options: {
		live: { type: "boolean" },
		profile: { type: "string" },
		model: { type: "string" },
		config: { type: "string" },
		"server-version": { type: "string" },
		quantization: { type: "string" },
		hardware: { type: "string" },
	},
});
const provider = resolveProvider(
	{ profile: values.profile, model: values.model },
	{ configPath: values.config },
);
for (const fixture of codingFixtures) {
	try {
		const result = await runCodingFixture(fixture, {
			provider,
			live: values.live,
			serverVersion: values["server-version"],
			quantization: values.quantization,
			hardware: values.hardware,
		});
		console.log(JSON.stringify(result));
		if (!result.completion || result.unauthorizedActions) process.exitCode = 1;
	} catch (error) {
		console.error(
			JSON.stringify({
				task: fixture.name,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		process.exitCode = 1;
	}
}
