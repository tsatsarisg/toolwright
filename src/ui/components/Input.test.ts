import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Box, render, useInput } from "ink";
import { createElement } from "react";
import { Input } from "./Input.tsx";

test("bracketed paste preserves lines without submitting or approving tools; modified Enter adds a line", async () => {
	const stdin = Object.assign(new PassThrough(), {
		isTTY: true,
		setRawMode: () => stdin,
		ref: () => stdin,
		unref: () => stdin,
	});
	const stdout = Object.assign(
		new Writable({ write: (_chunk, _encoding, callback) => callback() }),
		{ isTTY: true, columns: 80, rows: 24 },
	);
	const submissions: string[] = [];
	let approvalKeys = 0;
	function ApprovalListener() {
		useInput((_input, key) => {
			if (key.return || key.escape || key.ctrl) approvalKeys++;
		});
		return null;
	}
	const tree = (disabled = false) =>
		createElement(
			Box,
			null,
			createElement(Input, {
				disabled,
				onSubmit: (value: string) => submissions.push(value),
			}),
			createElement(ApprovalListener),
		);
	const app = render(tree(), {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: stdout as unknown as NodeJS.WriteStream,
		interactive: true,
		exitOnCtrlC: false,
		patchConsole: false,
		kittyKeyboard: { mode: "disabled" },
	});
	const send = async (text: string) => {
		stdin.write(text);
		await setImmediate();
		await app.waitUntilRenderFlush();
	};
	try {
		await setImmediate();
		await app.waitUntilRenderFlush();
		await send("\u001b[200~first\r\nsecond\n\u001b[201~");
		assert.deepEqual(submissions, []);
		assert.equal(approvalKeys, 0);
		await send("\r");
		assert.deepEqual(submissions, ["first\nsecond\n"]);
		await send("third");
		await send("\u001b[13;2u"); // Kitty Shift+Enter.
		await send("fourth");
		await send("\r");
		assert.equal(submissions[1], "third\nfourth");
		app.rerender(tree(true));
		await setImmediate();
		await app.waitUntilRenderFlush();
		const before = approvalKeys;
		await send("\u001b[200~\r\nyes\r\n\u001b[201~");
		assert.equal(approvalKeys, before);
		assert.equal(submissions.length, 2);
	} finally {
		app.unmount();
		await app.waitUntilExit();
		app.cleanup();
		stdin.destroy();
		stdout.destroy();
	}
});
