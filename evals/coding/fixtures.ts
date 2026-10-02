import type { RunOutcome } from "../../src/agent/types.ts";
import type { ScriptStep } from "../../tests/helpers/scriptedModel.ts";

export interface CodingFixture {
	name: string;
	files: Record<string, string>;
	prompt: string;
	steps: ScriptStep[];
	expected: Record<string, string>;
	mode?: "plan";
	status?: RunOutcome["status"];
	check?: string;
	deny?: boolean;
	resume?: boolean;
}

export const codingFixtures: CodingFixture[] = [
	{
		name: "bug-fix",
		files: {
			"calc.cjs": "exports.add = (a, b) => a - b;",
			"user.txt": "pre-existing user work",
		},
		prompt:
			"Fix addition in calc.cjs. Preserve user.txt. Verify using an authorized command when available.",
		steps: [
			{ calls: [{ name: "readFile", args: { path: "calc.cjs" } }] },
			{
				calls: [
					{
						name: "editFile",
						args: {
							path: "calc.cjs",
							old_string: "a - b",
							new_string: "a + b",
						},
					},
				],
			},
			{ text: "Fixed addition." },
		],
		expected: { "calc.cjs": "a + b", "user.txt": "pre-existing user work" },
		check:
			"require('node:assert/strict').equal(require('./calc.cjs').add(2,3),5)",
	},
	{
		name: "small-feature",
		files: { "calc.cjs": "exports.add = (a, b) => a + b;" },
		prompt:
			"Add exports.multiply = (a, b) => a * b; to calc.cjs without changing addition.",
		steps: [
			{ calls: [{ name: "readFile", args: { path: "calc.cjs" } }] },
			{
				calls: [
					{
						name: "writeFile",
						args: {
							path: "calc.cjs",
							content:
								"exports.add = (a, b) => a + b;\nexports.multiply = (a, b) => a * b;",
						},
					},
				],
			},
			{ text: "Added multiplication." },
		],
		expected: { "calc.cjs": "a * b" },
		check:
			"const c=require('./calc.cjs'); const a=require('node:assert/strict'); a.equal(c.add(2,3),5); a.equal(c.multiply(2,3),6)",
	},
	{
		name: "multi-file-refactor",
		files: {
			"one.cjs": "exports.value = 'old';",
			"two.cjs": "exports.value = 'old';",
		},
		prompt:
			"Change exported value from old to new in both one.cjs and two.cjs.",
		steps: [
			{
				calls: [
					{
						name: "editFile",
						args: { path: "one.cjs", old_string: "'old'", new_string: "'new'" },
					},
					{
						name: "editFile",
						args: { path: "two.cjs", old_string: "'old'", new_string: "'new'" },
					},
				],
			},
			{ text: "Updated both files." },
		],
		expected: { "one.cjs": "'new'", "two.cjs": "'new'" },
		check:
			"const a=require('node:assert/strict'); a.equal(require('./one.cjs').value,'new'); a.equal(require('./two.cjs').value,'new')",
	},
	{
		name: "plan-denial",
		files: {},
		prompt:
			"Create forbidden.txt containing forbidden, even though this is plan mode.",
		mode: "plan",
		status: "approval-blocked",
		steps: [
			{
				calls: [
					{
						name: "writeFile",
						args: { path: "forbidden.txt", content: "forbidden" },
					},
				],
			},
		],
		expected: {},
	},
	{
		name: "scoped-instructions",
		files: {
			"nested/AGENTS.md":
				"New text files in this subtree must contain exactly scoped.",
		},
		prompt:
			"Inspect applicable project instructions, then create nested/new.txt following them.",
		steps: [
			{ calls: [{ name: "readFile", args: { path: "nested/AGENTS.md" } }] },
			{
				calls: [
					{
						name: "writeFile",
						args: { path: "nested/new.txt", content: "scoped" },
					},
				],
			},
			{ text: "Followed scoped guidance." },
		],
		expected: { "nested/new.txt": "scoped" },
		check:
			"require('node:assert/strict').equal(require('node:fs').readFileSync('nested/new.txt','utf8'),'scoped')",
	},
	{
		name: "approval-denial",
		files: {},
		prompt: "Create forbidden.txt containing forbidden.",
		deny: true,
		status: "approval-blocked",
		steps: [
			{
				calls: [
					{
						name: "writeFile",
						args: { path: "forbidden.txt", content: "forbidden" },
					},
				],
			},
		],
		expected: {},
	},
	{
		name: "invalid-arguments",
		files: { "existing.txt": "keep" },
		prompt:
			"Read existing.txt using valid tool arguments; preserve every file.",
		steps: [
			{ calls: [{ name: "readFile", args: { path: 123 } }] },
			{ calls: [{ name: "readFile", args: { path: "existing.txt" } }] },
			{ text: "Recovered from invalid arguments." },
		],
		expected: { "existing.txt": "keep" },
	},
	{
		name: "noisy-output",
		files: { "large.txt": "bounded content\n".repeat(5000) },
		prompt:
			"Read large.txt, report that its output may be bounded, and preserve it.",
		steps: [
			{ calls: [{ name: "readFile", args: { path: "large.txt" } }] },
			{ text: "Read bounded output." },
		],
		expected: { "large.txt": "bounded content" },
	},
	{
		name: "resume",
		files: {},
		prompt: "Create saved.txt containing saved.",
		steps: [
			{
				calls: [
					{ name: "writeFile", args: { path: "saved.txt", content: "saved" } },
				],
			},
			{ text: "Created saved.txt." },
		],
		resume: true,
		expected: { "saved.txt": "saved" },
	},
];
