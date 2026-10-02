/** Argument summaries shown by the terminal approval view. */
export const PREVIEW_ARG_KEYS: Record<string, string[]> = {
	readFile: ["path"],
	writeFile: ["path"],
	editFile: ["path"],
	listFiles: ["directory"],
	deleteFile: ["path"],
	globFiles: ["pattern"],
	searchCode: ["pattern"],
	runCommand: ["command"],
};
