import fs from "node:fs/promises";
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { PREVIEW_ARG_KEYS } from "../../agent/tools/index.ts";
import { truncate } from "../../agent/tools/truncate.ts";

interface ToolApprovalProps {
	toolName: string;
	args: unknown;
	/** Show elevated-risk styling (writeFile/editFile/deleteFile/runCommand). */
	destructive: boolean;
	onResolve: (decision: "once" | "always" | "no") => void;
}

const MAX_PREVIEW_LINES = 5;
const SUMMARY_MAX_CHARS = 50;
/** Fallback preview keys for any tool not listed in PREVIEW_ARG_KEYS. */
const DEFAULT_PREVIEW_KEYS = ["path", "command", "query"];

function formatArgs(args: unknown): { preview: string; extraLines: number } {
	const formatted = JSON.stringify(args, null, 2);
	const lines = formatted.split("\n");

	if (lines.length <= MAX_PREVIEW_LINES) {
		return { preview: formatted, extraLines: 0 };
	}

	const preview = lines.slice(0, MAX_PREVIEW_LINES).join("\n");
	const extraLines = lines.length - MAX_PREVIEW_LINES;
	return { preview, extraLines };
}

function getArgsSummary(toolName: string, args: unknown): string {
	if (typeof args !== "object" || args === null) {
		return String(args);
	}

	const obj = args as Record<string, unknown>;
	const previewKeys = PREVIEW_ARG_KEYS[toolName] ?? DEFAULT_PREVIEW_KEYS;
	for (const key of previewKeys) {
		if (key in obj && typeof obj[key] === "string") {
			return truncate(obj[key] as string, SUMMARY_MAX_CHARS);
		}
	}

	// Fall back to the first string-valued key.
	const keys = Object.keys(obj);
	if (keys.length > 0 && typeof obj[keys[0]] === "string") {
		return truncate(obj[keys[0]] as string, SUMMARY_MAX_CHARS);
	}

	return "";
}

/**
 * For writeFile, tell the user whether this creates a new file or overwrites
 * an existing one (and how big it currently is) — the raw JSON args preview
 * shows only the NEW content, giving no sense of what's being destroyed.
 */
function useOverwriteNotice(toolName: string, args: unknown): string | null {
	const [notice, setNotice] = useState<string | null>(null);
	const filePath =
		toolName === "writeFile" &&
		typeof args === "object" &&
		args !== null &&
		typeof (args as Record<string, unknown>).path === "string"
			? ((args as Record<string, unknown>).path as string)
			: null;

	useEffect(() => {
		if (!filePath) {
			setNotice(null);
			return;
		}
		let cancelled = false;
		fs.stat(filePath).then(
			(stat) => {
				if (!cancelled) {
					setNotice(`This overwrites an existing ${stat.size}-byte file.`);
				}
			},
			() => {
				if (!cancelled) setNotice("This creates a new file.");
			},
		);
		return () => {
			cancelled = true;
		};
	}, [filePath]);

	return filePath ? notice : null;
}

export function ToolApproval({
	toolName,
	args,
	destructive,
	onResolve,
}: ToolApprovalProps) {
	const [selectedIndex, setSelectedIndex] = useState(0);
	const overwriteNotice = useOverwriteNotice(toolName, args);
	const options: Array<{ label: string; decision: "once" | "always" | "no" }> =
		[
			{ label: "Yes", decision: "once" },
			{ label: "Always allow this session", decision: "always" },
			{ label: "No", decision: "no" },
		];

	useInput(
		(_input, key) => {
			if (key.upArrow) {
				setSelectedIndex((prev) =>
					prev === 0 ? options.length - 1 : prev - 1,
				);
				return;
			}
			if (key.downArrow) {
				setSelectedIndex((prev) =>
					prev === options.length - 1 ? 0 : prev + 1,
				);
				return;
			}
			if (key.return) {
				onResolve(options[selectedIndex].decision);
			}
		},
		{ isActive: true },
	);

	const argsSummary = getArgsSummary(toolName, args);
	const { preview, extraLines } = formatArgs(args);
	const accent = destructive ? "red" : "yellow";

	return (
		<Box flexDirection="column" marginTop={1}>
			<Text color={accent} bold>
				{destructive
					? "⚠ Destructive action — approval required"
					: "Tool approval required"}
			</Text>
			<Box marginLeft={2} flexDirection="column">
				<Text>
					<Text color="cyan" bold>
						{toolName}
					</Text>
					{argsSummary && <Text dimColor>({argsSummary})</Text>}
				</Text>
				{overwriteNotice && (
					<Text
						color={
							overwriteNotice.startsWith("This overwrites") ? "red" : "gray"
						}
					>
						{overwriteNotice}
					</Text>
				)}
				<Box marginLeft={2} flexDirection="column">
					<Text dimColor>{preview}</Text>
					{extraLines > 0 && (
						<Text color="gray">... +{extraLines} more lines</Text>
					)}
				</Box>
			</Box>
			<Box marginTop={1} marginLeft={2} flexDirection="column">
				{options.map((option, index) => (
					<Text
						key={option.decision}
						color={selectedIndex === index ? "green" : "gray"}
						bold={selectedIndex === index}
					>
						{selectedIndex === index ? "› " : "  "}
						{option.label}
					</Text>
				))}
			</Box>
		</Box>
	);
}
