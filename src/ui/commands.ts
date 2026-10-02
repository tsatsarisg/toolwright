export const SESSION_HELP =
	"/model [profile] <id> — select between turns\n/plan — toggle plan/edit mode\n/diff — agent changes\n/compact — summarize history\n/exit — quit\nShift+Enter: newline; Escape/Ctrl+C: cancel active turn.";

export type SessionInput =
	| { kind: "exit" | "help" | "plan" | "diff" | "compact" }
	| { kind: "model"; args: string[] }
	| { kind: "prompt"; text: string };

export function parseSessionInput(input: string): SessionInput {
	const [command, ...args] = input.trim().split(/\s+/);
	switch (command) {
		case "exit":
		case "quit":
		case "/exit":
			return { kind: "exit" };
		case "/help":
			return { kind: "help" };
		case "/plan":
			return { kind: "plan" };
		case "/diff":
			return { kind: "diff" };
		case "/compact":
			return { kind: "compact" };
		case "/model":
			return { kind: "model", args };
		default:
			if (command.startsWith("/")) {
				throw new Error("Unknown slash command. Use /help.");
			}
			return { kind: "prompt", text: input };
	}
}
