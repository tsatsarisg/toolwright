export interface FileChange {
	path: string;
	before: string | null;
	after: string | null;
}

export interface CommandResult {
	command: string;
	cwd: string;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	cancelled: boolean;
	overflowed: boolean;
	durationMs: number;
}
