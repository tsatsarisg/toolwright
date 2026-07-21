/**
 * Cap tool output so a single large result can't blow the context window.
 * Keeps the head of the output and appends a marker so the model knows the
 * text was cut (and by how much) rather than silently seeing partial data.
 */
const DEFAULT_MAX_CHARS = 16_000;

export function truncateOutput(
	text: string,
	maxChars: number = DEFAULT_MAX_CHARS,
): string {
	if (text.length <= maxChars) {
		return text;
	}

	const head = text.slice(0, maxChars);
	const omitted = text.length - maxChars;
	return `${head}\n\n[... output truncated: ${omitted} more characters omitted ...]`;
}

/**
 * Cap a string to `maxLen` characters with a short trailing marker. For
 * short inline previews (an approval prompt's arg summary, a tool-call
 * result line) — truncateOutput's fuller "N characters omitted" marker is
 * for tool output headed back to the model, not one-line UI text.
 */
export function truncate(text: string, maxLen: number, marker = "..."): string {
	if (text.length <= maxLen) {
		return text;
	}
	return text.slice(0, maxLen) + marker;
}
