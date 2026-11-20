/**
 * Runs git as a child process: arguments as an array, never a shell string, and
 * expected failures returned as typed values.
 *
 * Every run is isolated from the machine's git setup so the same command gives the
 * same output everywhere: no system or global config, no inherited `GIT_*`
 * variables, no pager, no prompts, and C-locale messages so stderr can be
 * recognised. Repository-local config still applies; diff delver's own store has
 * none that matters, and callers pass `-c` for anything they depend on.
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { devNull } from 'node:os';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';

export interface GitCommand {
	/** The directory git runs in: a work tree, or a bare repository. */
	readonly cwd: AbsolutePath;
	readonly args: readonly string[];
	/** Written to git's stdin, then stdin is closed. */
	readonly input?: string | Uint8Array;
	/** Extra environment, applied after the isolation settings. */
	readonly env?: Readonly<Record<string, string>>;
}

export interface GitOutput {
	readonly stdout: Buffer;
	readonly stderr: string;
}

/** git is not installed, or not on the PATH. */
export interface GitNotFound {
	readonly kind: 'GitNotFound';
}

/** The directory does not exist, or is not inside a git repository. */
export interface NotARepository {
	readonly kind: 'NotARepository';
	readonly directory: AbsolutePath;
	readonly stderr: string;
}

/** A revision, tree or object named in the arguments does not exist. */
export interface BadRevision {
	readonly kind: 'BadRevision';
	readonly args: readonly string[];
	readonly stderr: string;
}

/** git ran and failed for another reason. */
export interface GitFailed {
	readonly kind: 'GitFailed';
	readonly args: readonly string[];
	readonly exitCode: number;
	readonly stderr: string;
}

export type GitError = GitNotFound | NotARepository | BadRevision | GitFailed;

const NOT_A_REPOSITORY = /not a git repository/i;
const BAD_REVISION =
	/bad revision|unknown revision|needed a single revision|bad object|not a valid object name|not a tree object|invalid object name|ambiguous argument/i;

/** The environment every git run gets: the parent's, minus git's own variables. */
function isolatedEnv(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (!name.startsWith('GIT_')) env[name] = value;
	}
	return {
		...env,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: devNull,
		GIT_ATTR_NOSYSTEM: '1',
		GIT_TERMINAL_PROMPT: '0',
		GIT_PAGER: 'cat',
		GIT_OPTIONAL_LOCKS: '0',
		LC_ALL: 'C',
		LANGUAGE: 'C',
		...extra
	};
}

/** Runs one git command to completion and returns its output, or why it failed. */
export async function runGit(command: GitCommand): Promise<Result<GitOutput, GitError>> {
	const directory = await stat(command.cwd).catch(() => undefined);
	if (directory?.isDirectory() !== true) {
		return err({ kind: 'NotARepository', directory: command.cwd, stderr: '' });
	}

	return new Promise((resolve) => {
		const child = spawn('git', command.args, {
			cwd: command.cwd,
			env: isolatedEnv(command.env),
			stdio: ['pipe', 'pipe', 'pipe']
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
		// git may exit before reading all of its input; that is reported by its exit code.
		child.stdin.on('error', () => undefined);
		child.stdin.end(command.input);

		child.on('error', (error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') resolve(err({ kind: 'GitNotFound' }));
			else resolve(err(failed(command, -1, error.message)));
		});
		child.on('close', (code) => {
			const errText = Buffer.concat(stderr).toString('utf8');
			if (code === 0) {
				resolve(ok({ stdout: Buffer.concat(stdout), stderr: errText }));
			} else if (NOT_A_REPOSITORY.test(errText)) {
				resolve(err({ kind: 'NotARepository', directory: command.cwd, stderr: errText }));
			} else if (BAD_REVISION.test(errText)) {
				resolve(err({ kind: 'BadRevision', args: command.args, stderr: errText }));
			} else {
				resolve(err(failed(command, code ?? -1, errText)));
			}
		});
	});
}

function failed(command: GitCommand, exitCode: number, stderr: string): GitFailed {
	return { kind: 'GitFailed', args: command.args, exitCode, stderr };
}

/** Runs a git command and returns its stdout as text, without a trailing newline. */
export async function runGitText(command: GitCommand): Promise<Result<string, GitError>> {
	const result = await runGit(command);
	return result.ok ? ok(result.value.stdout.toString('utf8').replace(/\n$/, '')) : result;
}

/** What happened and what to do next, for the reviewer. */
export function describeGitError(error: GitError): string {
	switch (error.kind) {
		case 'GitNotFound':
			return 'git could not be found. Install git and make sure it is on your PATH, then try again.';
		case 'NotARepository':
			return `${error.directory} is not a git repository. Run diff delver inside a repository, or pass its path.`;
		case 'BadRevision':
			return `git does not know one of the revisions asked for: ${firstLine(error.stderr)} Check the name, or fetch it first.`;
		case 'GitFailed':
			return `git ${error.args[0] ?? ''} failed (exit code ${error.exitCode}): ${firstLine(error.stderr)}`;
	}
}

function firstLine(text: string): string {
	return text.trim().split('\n')[0] ?? '';
}
