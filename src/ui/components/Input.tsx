import { Box, Text, useInput, usePaste } from "ink";
import { useState } from "react";

interface InputProps {
	onSubmit: (value: string) => void;
	disabled?: boolean;
}

export function Input({ onSubmit, disabled = false }: InputProps) {
	const [value, setValue] = useState("");
	usePaste((text) => {
		if (!disabled) setValue((prev) => prev + text.replace(/\r\n?/g, "\n"));
	});

	useInput((input, key) => {
		if (disabled) return;

		if (key.return) {
			if (key.shift || key.meta) {
				setValue((prev) => `${prev}\n`);
				return;
			}
			if (value.trim()) {
				onSubmit(value);
				setValue("");
			}
			return;
		}

		if (key.backspace || key.delete) {
			setValue((prev) => prev.slice(0, -1));
			return;
		}

		if (input && !key.ctrl && !key.meta) {
			setValue((prev) => prev + input.replace(/\r\n?/g, "\n"));
		}
	});

	return (
		<Box>
			<Text color="blue" bold>
				{"> "}
			</Text>
			<Text>{value}</Text>
			{!disabled && <Text color="gray">▌</Text>}
		</Box>
	);
}
