import type { ModelMessage } from "ai";
import { Box, Text, useApp } from "ink";
import { useCallback, useRef, useState } from "react";
import { extractMessageText } from "../agent/context/tokenEstimator.ts";
import { runAgent } from "../agent/run.ts";
import { saveSession } from "../agent/session.ts";
import { DESTRUCTIVE_TOOLS } from "../agent/tools/index.ts";
import type { TokenUsageInfo, ToolApprovalRequest } from "../types.ts";
import { Input } from "./components/Input.tsx";
import { type Message, MessageList } from "./components/MessageList.tsx";
import { Spinner } from "./components/Spinner.tsx";
import { TokenUsage } from "./components/TokenUsage.tsx";
import { ToolApproval } from "./components/ToolApproval.tsx";
import { ToolCall, type ToolCallProps } from "./components/ToolCall.tsx";

interface AppProps {
	/** Id this session is saved under (~/.toolwright/sessions/<project>/<id>.json). */
	sessionId: string;
	/** History loaded back in via --resume, if any. */
	initialHistory?: ModelMessage[];
	/** Model id override from --model. */
	model?: string;
}

/** Rebuild the display transcript from a resumed history (tool messages are replay-only, not shown as bubbles). */
function messagesFromHistory(history: ModelMessage[]): Message[] {
	return history
		.filter(
			(m): m is ModelMessage & { role: "user" | "assistant" } =>
				m.role === "user" || m.role === "assistant",
		)
		.map((m, i) => ({
			id: `resumed-${i}`,
			role: m.role,
			content: extractMessageText(m),
		}))
		.filter((m) => m.content.trim().length > 0);
}

interface ActiveToolCall extends ToolCallProps {
	id: string;
}

/**
 * Everything that can be true DURING a turn. streamingText and toolCalls are
 * not mutually exclusive — a single model response can stream text and emit
 * tool calls together — so they're tracked side by side. pendingApproval
 * overlays on top without erasing either: once it resolves, whatever text/
 * tool-call progress had already accumulated is still there underneath it.
 */
interface WorkingState {
	streamingText: string;
	toolCalls: ActiveToolCall[];
	pendingApproval: ToolApprovalRequest | null;
}

type TurnState = { status: "idle" } | ({ status: "working" } & WorkingState);

const IDLE_TURN: TurnState = { status: "idle" };
const newWorkingTurn = (): TurnState => ({
	status: "working",
	streamingText: "",
	toolCalls: [],
	pendingApproval: null,
});

export function App({ sessionId, initialHistory = [], model }: AppProps) {
	const { exit } = useApp();
	const [messages, setMessages] = useState<Message[]>(() =>
		messagesFromHistory(initialHistory),
	);
	const [conversationHistory, setConversationHistory] =
		useState<ModelMessage[]>(initialHistory);
	const [turn, setTurn] = useState<TurnState>(IDLE_TURN);
	const [tokenUsage, setTokenUsage] = useState<TokenUsageInfo | null>(null);
	// Tools the user chose "Always allow" for, this session only (in-memory,
	// never written to disk) — checked before a prompt is even shown.
	const alwaysAllowedRef = useRef<Set<string>>(new Set());
	const nextMessageId = useRef(0);
	const makeMessage = useCallback(
		(role: Message["role"], content: string): Message => ({
			id: `m${nextMessageId.current++}`,
			role,
			content,
		}),
		[],
	);

	const handleSubmit = useCallback(
		async (userInput: string) => {
			if (
				userInput.toLowerCase() === "exit" ||
				userInput.toLowerCase() === "quit"
			) {
				exit();
				return;
			}

			setMessages((prev) => [...prev, makeMessage("user", userInput)]);
			setTurn(newWorkingTurn());

			try {
				const newHistory = await runAgent(
					userInput,
					conversationHistory,
					{
						onToken: (token) => {
							setTurn((prev) =>
								prev.status === "working"
									? { ...prev, streamingText: prev.streamingText + token }
									: prev,
							);
						},
						onToolCallStart: (name, args, toolCallId) => {
							setTurn((prev) =>
								prev.status === "working"
									? {
											...prev,
											toolCalls: [
												...prev.toolCalls,
												{ id: toolCallId, name, args, status: "pending" },
											],
										}
									: prev,
							);
						},
						onToolCallEnd: (toolCallId, result) => {
							setTurn((prev) =>
								prev.status === "working"
									? {
											...prev,
											toolCalls: prev.toolCalls.map((tc) =>
												tc.id === toolCallId
													? { ...tc, status: "complete", result }
													: tc,
											),
										}
									: prev,
							);
						},
						onComplete: (response) => {
							if (response) {
								setMessages((prev) => [
									...prev,
									makeMessage("assistant", response),
								]);
							}
							setTurn(IDLE_TURN);
						},
						onToolApproval: (name, args) => {
							if (alwaysAllowedRef.current.has(name)) {
								return Promise.resolve(true);
							}
							return new Promise<boolean>((resolve) => {
								setTurn((prev) =>
									prev.status === "working"
										? {
												...prev,
												pendingApproval: { toolName: name, args, resolve },
											}
										: prev,
								);
							});
						},
						onTokenUsage: (usage) => {
							setTokenUsage(usage);
						},
					},
					{ model },
				);

				setConversationHistory(newHistory);
				// Best-effort: a failed save shouldn't interrupt the session.
				saveSession(sessionId, newHistory).catch(() => {});
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				setMessages((prev) => [
					...prev,
					makeMessage("assistant", `Error: ${errorMessage}`),
				]);
				setTurn(IDLE_TURN);
			}
		},
		[conversationHistory, exit, makeMessage, model, sessionId],
	);

	const working = turn.status === "working" ? turn : null;
	const pendingApproval = working?.pendingApproval ?? null;
	const isThinking =
		working !== null &&
		!working.streamingText &&
		working.toolCalls.length === 0 &&
		!pendingApproval;

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="magenta">
					🤖 AI Agent
				</Text>
				<Text dimColor> (type "exit" to quit)</Text>
			</Box>

			<Box flexDirection="column" marginBottom={1}>
				<MessageList messages={messages} />

				{working?.streamingText && (
					<Box flexDirection="column" marginTop={1}>
						<Text color="green" bold>
							› Assistant
						</Text>
						<Box marginLeft={2}>
							<Text>{working.streamingText}</Text>
							<Text color="gray">▌</Text>
						</Box>
					</Box>
				)}

				{working && working.toolCalls.length > 0 && !pendingApproval && (
					<Box flexDirection="column" marginTop={1}>
						{working.toolCalls.map((tc) => (
							<ToolCall
								key={tc.id}
								name={tc.name}
								args={tc.args}
								status={tc.status}
								result={tc.result}
							/>
						))}
					</Box>
				)}

				{isThinking && (
					<Box marginTop={1}>
						<Spinner />
					</Box>
				)}

				{pendingApproval && (
					<ToolApproval
						toolName={pendingApproval.toolName}
						args={pendingApproval.args}
						destructive={DESTRUCTIVE_TOOLS.has(pendingApproval.toolName)}
						onResolve={(decision) => {
							if (decision === "always") {
								alwaysAllowedRef.current.add(pendingApproval.toolName);
							}
							pendingApproval.resolve(decision !== "no");
							setTurn((prev) =>
								prev.status === "working"
									? { ...prev, pendingApproval: null }
									: prev,
							);
						}}
					/>
				)}
			</Box>

			{!pendingApproval && (
				<Input onSubmit={handleSubmit} disabled={turn.status === "working"} />
			)}

			<TokenUsage usage={tokenUsage} />
		</Box>
	);
}
