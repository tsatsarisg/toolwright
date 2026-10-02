import type { ModelMessage } from "ai";
import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useRef, useState } from "react";
import {
	compactConversation,
	defaultSummarizer,
} from "../agent/context/compaction.ts";
import { extractMessageText } from "../agent/context/tokenEstimator.ts";
import { type ResolvedProvider, resolveProvider } from "../agent/model.ts";
import type { ApprovalDetails, ExecutionPolicy } from "../agent/policy.ts";
import { runAgent } from "../agent/run.ts";
import { type SessionStore, sessionSnapshot } from "../agent/session.ts";
import { portableHistory } from "../agent/system/filterMessages.ts";
import type { Workspace } from "../agent/workspace.ts";
import type {
	RunOutcome,
	TokenUsageInfo,
	ToolApprovalRequest,
} from "../types.ts";
import { Input } from "./components/Input.tsx";
import { type Message, MessageList } from "./components/MessageList.tsx";
import { Spinner } from "./components/Spinner.tsx";
import { TokenUsage } from "./components/TokenUsage.tsx";
import { ToolApproval } from "./components/ToolApproval.tsx";
import { ToolCall, type ToolCallProps } from "./components/ToolCall.tsx";

interface AppProps {
	sessionId: string;
	provider: ResolvedProvider;
	workspace: Workspace;
	store: SessionStore;
	policy: ExecutionPolicy;
	budgets?: { maxSteps?: number; maxTokens?: number; maxTurnMs?: number };
	configPath?: string;
	initialHistory?: ModelMessage[];
}
export function App({
	sessionId,
	provider: initialProvider,
	workspace,
	store,
	policy,
	budgets,
	configPath,
	initialHistory = [],
}: AppProps) {
	const { exit } = useApp();
	const [provider, setProvider] = useState(initialProvider);
	const [mode, setMode] = useState(policy.mode);
	const [messages, setMessages] = useState<Message[]>(
		initialHistory
			.filter((m) => m.role === "user" || m.role === "assistant")
			.map((m, index) => ({
				id: `resume-${index}`,
				role: m.role as Message["role"],
				content: extractMessageText(m),
			})),
	);
	const [working, setWorking] = useState(false);
	const [streaming, setStreaming] = useState("");
	const [output, setOutput] = useState("");
	const [toolCalls, setToolCalls] = useState<
		Array<ToolCallProps & { id: string }>
	>([]);
	const [approval, setApproval] = useState<ToolApprovalRequest | null>(null);
	const [usage, setUsage] = useState<TokenUsageInfo | null>(null);
	const nextId = useRef(0);
	const history = useRef(initialHistory);
	const outcome = useRef<RunOutcome | undefined>(undefined);
	const active = useRef<AbortController | null>(null);
	const pending = useRef<ToolApprovalRequest | null>(null);
	const add = useCallback((role: Message["role"], content: string) => {
		setMessages((prev) => [
			...prev,
			{ id: `message-${nextId.current++}`, role, content },
		]);
	}, []);
	const save = useCallback(
		async (currentHistory: ModelMessage[], selected = provider) => {
			history.current = currentHistory;
			try {
				await store.save(
					sessionSnapshot(
						sessionId,
						currentHistory,
						workspace,
						selected.settings,
						outcome.current,
					),
				);
			} catch (error) {
				add(
					"assistant",
					`Session save failed: ${error instanceof Error ? error.message : error}`,
				);
			}
		},
		[add, provider, sessionId, store, workspace],
	);
	const requestApproval = useCallback(
		(name: string, args: unknown, details?: ApprovalDetails) =>
			new Promise<boolean>((resolve) => {
				const request = { toolName: name, args, details, resolve };
				pending.current = request;
				setApproval(request);
			}),
		[],
	);
	const cancel = useCallback(() => {
		active.current?.abort(new Error("Cancelled by user"));
		pending.current?.resolve(false);
		pending.current = null;
		setApproval(null);
	}, []);
	useInput((input, key) => {
		if (key.escape || (key.ctrl && input === "c")) {
			if (active.current || pending.current) cancel();
			else if (key.ctrl) exit();
		}
	});
	const submit = useCallback(
		async (input: string) => {
			if (working) return;
			try {
				const [command, ...args] = input.trim().split(/\s+/);
				if (["exit", "quit", "/exit"].includes(command)) {
					exit();
					return;
				}
				if (command === "/help") {
					add(
						"assistant",
						"/model [profile] <id> — select between turns\n/plan — toggle plan/edit mode\n/diff — agent changes\n/compact — summarize history\n/exit — quit\nShift+Enter: newline; Escape/Ctrl+C: cancel active turn.",
					);
					return;
				}
				if (command === "/plan") {
					policy.mode = policy.mode === "plan" ? "edit" : "plan";
					setMode(policy.mode);
					add("assistant", `Permission mode: ${policy.mode}`);
					return;
				}
				if (command === "/diff") {
					add("assistant", workspace.diff());
					return;
				}
				if (command === "/model") {
					if (!args.length) {
						add(
							"assistant",
							`Current: ${provider.settings.profile}/${provider.settings.model}. Use /model [profile] <id>.`,
						);
						return;
					}
					if (args.length > 2) throw new Error("Use /model [profile] <id>.");
					const selection =
						args.length === 2
							? { profile: args[0], model: args[1] }
							: { ...provider.settings, model: args[0] };
					const selected = resolveProvider(selection, {
						configPath,
						cwd: workspace.root,
					});
					if (provider.settings.localOnly && !selected.settings.localOnly) {
						setWorking(true);
						const approved = await requestApproval(
							"sendSessionToProvider",
							{
								endpoint: selected.settings.baseURL,
								explanation:
									"Consent to send this local-only session's history to the selected provider and change its data policy.",
							},
							{
								kind: "network",
								destructive: true,
								grantKey: "cloud-transition",
							},
						);
						setWorking(false);
						if (!approved) {
							add("assistant", "Provider transition declined.");
							return;
						}
					}
					setProvider(selected);
					history.current = portableHistory(history.current);
					setUsage(null);
					await save(history.current, selected);
					add(
						"assistant",
						`Selected ${selected.settings.profile}/${selected.settings.model} (${selected.limits.contextWindow} context tokens).`,
					);
					return;
				}
				if (command.startsWith("/") && command !== "/compact")
					throw new Error("Unknown slash command. Use /help.");
				outcome.current = undefined;
				active.current = new AbortController();
				setWorking(true);
				setStreaming("");
				setOutput("");
				setToolCalls([]);
				if (command === "/compact") {
					await save(
						await compactConversation(
							history.current,
							provider,
							defaultSummarizer(provider, active.current.signal),
							{ includeCurrentTurn: true },
						),
					);
					add("assistant", "Conversation compacted.");
					return;
				}
				add("user", input);
				await runAgent(
					input,
					history.current,
					{
						onToken: (token) => setStreaming((prev) => prev + token),
						onToolCallStart: (name, args, id) =>
							setToolCalls((prev) => [
								...prev,
								{ id, name, args, status: "pending" },
							]),
						onToolCallEnd: (id, result) =>
							setToolCalls((prev) =>
								prev.map((call) =>
									call.id === id
										? { ...call, status: "complete", result }
										: call,
								),
							),
						onToolApproval: requestApproval,
						onCommandOutput: (text) =>
							setOutput((prev) => (prev + text).slice(-8000)),
						onTokenUsage: setUsage,
						onOutcome: (result) => {
							outcome.current = result;
						},
						onCheckpoint: save,
						onComplete: (text) => {
							if (text) add("assistant", text);
						},
					},
					{
						resolvedProvider: provider,
						workspace,
						policy,
						...budgets,
						signal: active.current.signal,
					},
				);
			} catch (error) {
				add(
					"assistant",
					`Error: ${error instanceof Error ? error.message : error}`,
				);
			} finally {
				active.current = null;
				pending.current = null;
				setApproval(null);
				setWorking(false);
				setStreaming("");
			}
		},
		[
			working,
			exit,
			add,
			policy,
			provider,
			configPath,
			workspace,
			requestApproval,
			save,
			budgets,
		],
	);
	return (
		<Box flexDirection="column" padding={1}>
			<Box flexDirection="column" marginBottom={1}>
				<Text bold color="magenta">
					Toolwright · {provider.settings.profile}/{provider.settings.model} ·{" "}
					{mode}
					{provider.settings.localOnly ? " · local-only" : ""}
				</Text>
				<Text dimColor>
					{workspace.root} · /help for commands · Escape cancels
				</Text>
			</Box>
			<MessageList messages={messages} />
			{working && streaming && <Text color="green">{streaming}</Text>}
			{working && !streaming && !approval && <Spinner />}
			{working && toolCalls.map((call) => <ToolCall key={call.id} {...call} />)}
			{working && output && (
				<Box marginTop={1}>
					<Text dimColor>{output}</Text>
				</Box>
			)}
			{approval && (
				<ToolApproval
					toolName={approval.toolName}
					args={approval.args}
					destructive={approval.details?.destructive ?? true}
					preview={approval.details?.preview}
					allowGrant={!!approval.details && !approval.details.destructive}
					onResolve={(decision) => {
						if (decision === "always" && approval.details)
							policy.grant(approval.details);
						approval.resolve(decision !== "no");
						pending.current = null;
						setApproval(null);
					}}
				/>
			)}
			{!approval && <Input onSubmit={submit} disabled={working} />}
			<TokenUsage usage={usage} />
		</Box>
	);
}
