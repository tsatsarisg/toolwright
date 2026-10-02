export function fileDiff(
	file: string,
	before: string | null,
	after: string | null,
): string {
	if (before === after) return "";
	const beforeLines = before === null ? [] : before.split("\n");
	const afterLines = after === null ? [] : after.split("\n");
	let start = 0;
	while (
		start < beforeLines.length &&
		start < afterLines.length &&
		beforeLines[start] === afterLines[start]
	)
		start++;
	let beforeEnd = beforeLines.length;
	let afterEnd = afterLines.length;
	while (
		beforeEnd > start &&
		afterEnd > start &&
		beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]
	) {
		beforeEnd--;
		afterEnd--;
	}
	const contextStart = Math.max(0, start - 3);
	const tail = Math.min(
		3,
		beforeLines.length - beforeEnd,
		afterLines.length - afterEnd,
	);
	return [
		`--- ${before === null ? "/dev/null" : `a/${file}`}`,
		`+++ ${after === null ? "/dev/null" : `b/${file}`}`,
		`@@ -${contextStart + 1},${beforeEnd + tail - contextStart} +${contextStart + 1},${afterEnd + tail - contextStart} @@`,
		...beforeLines.slice(contextStart, start).map((line) => ` ${line}`),
		...beforeLines.slice(start, beforeEnd).map((line) => `-${line}`),
		...afterLines.slice(start, afterEnd).map((line) => `+${line}`),
		...beforeLines.slice(beforeEnd, beforeEnd + tail).map((line) => ` ${line}`),
	].join("\n");
}
