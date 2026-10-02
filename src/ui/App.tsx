import { Box, Text } from "ink";
import { Input } from "./components/Input.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { Spinner } from "./components/Spinner.tsx";
import { TokenUsage } from "./components/TokenUsage.tsx";
import { ToolApproval } from "./components/ToolApproval.tsx";
import { ToolCall } from "./components/ToolCall.tsx";
import {
	type CodingSessionOptions,
	useCodingSession,
} from "./useCodingSession.ts";

export function App(props: CodingSessionOptions) {
	const { workspace } = props;
	const {
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
	} = useCodingSession(props);
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
					onResolve={resolveApproval}
				/>
			)}
			{!approval && <Input onSubmit={submit} disabled={working} />}
			<TokenUsage usage={usage} />
		</Box>
	);
}
