import type { ModelMessage } from "ai";
import { useApp, useInput } from "ink";
import { useCallback, useRef, useState } from "react";
import {
	compactConversation,
	defaultSummarizer,
} from "../agent/context/compaction.ts";
import { extractMessageText } from "../agent/context/tokenEstimator.ts";
import type { TokenUsageInfo } from "../agent/context/types.ts";
import type {
	ApprovalDetails,
	ExecutionPolicy,
} from "../agent/execution/policy.ts";
import { portableHistory } from "../agent/history/filterMessages.ts";
import { runAgent } from "../agent/run.ts";
import type { RunOutcome } from "../agent/types.ts";
import {
	type ResolvedProvider,
	resolveProvider,
} from "../providers/resolve.ts";
import { sessionSnapshot } from "../sessions/snapshot.ts";
import type { SessionStore } from "../sessions/store.ts";
import type { Workspace } from "../workspace/workspace.ts";
import { parseSessionInput, SESSION_HELP } from "./commands.ts";
import type { Message } from "./components/MessageList.tsx";
import type { ToolCallProps } from "./components/ToolCall.tsx";
import type { ToolApprovalRequest } from "./types.ts";

export interface CodingSessionOptions {
	sessionId: string;
	provider: ResolvedProvider;
	workspace: Workspace;
	store: SessionStore;
	policy: ExecutionPolicy;
	budgets?: { maxSteps?: number; maxTokens?: number; maxTurnMs?: number };
	configPath?: string;
	initialHistory?: ModelMessage[];
}
export function useCodingSession({
	sessionId,
	provider: initialProvider,
	workspace,
	store,
	policy,
	budgets,
	configPath,
	initialHistory = [],
}: CodingSessionOptions) {
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
	const selectModel = useCallback(
		async (args: string[]) => {
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
		},
		[add, provider, configPath, workspace, requestApproval, save],
	);
	const submit = useCallback(
		async (input: string) => {
			if (working) return;
			try {
				const command = parseSessionInput(input);
				if (command.kind === "exit") {
					exit();
					return;
				}
				if (command.kind === "help") {
					add("assistant", SESSION_HELP);
					return;
				}
				if (command.kind === "plan") {
					policy.mode = policy.mode === "plan" ? "edit" : "plan";
					setMode(policy.mode);
					add("assistant", `Permission mode: ${policy.mode}`);
					return;
				}
				if (command.kind === "diff") {
					add("assistant", workspace.diff());
					return;
				}
				if (command.kind === "model") {
					await selectModel(command.args);
					return;
				}
				outcome.current = undefined;
				active.current = new AbortController();
				setWorking(true);
				setStreaming("");
				setOutput("");
				setToolCalls([]);
				if (command.kind === "compact") {
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
			workspace,
			save,
			budgets,
			requestApproval,
			selectModel,
		],
	);
	const resolveApproval = useCallback(
		(decision: "once" | "always" | "no") => {
			if (!approval) return;
			if (decision === "always" && approval.details)
				policy.grant(approval.details);
			approval.resolve(decision !== "no");
			pending.current = null;
			setApproval(null);
		},
		[approval, policy],
	);
	return {
		provider,
		mode,
		messages,
		working,
		streaming,
		output,
		toolCalls,
		approval,
		usage,
		submit,
		resolveApproval,
	};
}
