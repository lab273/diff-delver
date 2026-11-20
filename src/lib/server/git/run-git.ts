/**
 * Runs git as a child process: arguments as an array, never a shell string, and
 * expected failures returned as typed values.
 *
 * By default every run is isolated from the machine's git setup so the same
 * command gives the same output everywhere: no system or global config, no
 * inherited `GIT_*` variables, no pager, no prompts, and C-locale messages so
 * stderr can be recognised. Repository-local config still applies; diff delver's
 * own store has none that matters, and callers pass `-c` for anything they depend
 * on.
 *
 * Commands run in the reviewed repository itself use the reviewer's config
 * instead (`config: 'reviewer'`): what `git add` would store depends on their
 * global ignore rules, line-ending and filter settings, and git refuses a
 * repository owned by another account unless their `safe.directory` allows it.
 * Inherited `GIT_*` variables are still dropped, so nothing in the environment
 * can point git at another repository, index or object store. And such a
 * command can never fetch: in a partial clone git would download a missing
 * object into the repository, so `GIT_NO_LAZY_FETCH` is set last, where no
 * caller's environment can undo it, and a missing object is `MissingObject`.
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseExitCode, type ExitCode } from '#lib/core/exit-code.tiny.ts';
import {
	isAtLeast,
	MINIMUM_GIT_VERSION,
	parseGitVersion,
	type GitVersion
} from '#lib/core/git-version.tiny.ts';
import { firstLineOf, gitStderr, type GitStderr } from '#lib/core/git-stderr.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';

export interface GitCommand {
	/** The directory git runs in: a work tree, or a bare repository. */
	readonly cwd: AbsolutePath;
	readonly args: readonly string[];
	/** Written to git's stdin, then stdin is closed. */
	readonly input?: string | Uint8Array;
	/** Extra environment, applied after the isolation settings. */
	readonly env?: Readonly<Record<string, string>>;
	/**
	 * Which git config applies besides the repository's own: none (`isolated`, the
	 * default), or the reviewer's system and global config (`reviewer`), for
	 * commands in the reviewed repository, which also never fetch a missing object.
	 */
	readonly config?: 'isolated' | 'reviewer';
}

export interface GitOutput {
	readonly stdout: Buffer;
	readonly stderr: GitStderr;
}

/** git is not installed, or not on the PATH. */
export interface GitNotFound {
	readonly kind: 'GitNotFound';
}

/** The directory does not exist, or is not inside a git repository. */
export interface NotARepository {
	readonly kind: 'NotARepository';
	readonly directory: AbsolutePath;
	readonly stderr: GitStderr;
}

/**
 * git refuses to work in the repository because it belongs to another user
 * account and the reviewer's `safe.directory` setting does not allow it.
 */
export interface DubiousOwnership {
	readonly kind: 'DubiousOwnership';
	/** The repository git refused, as git named it. */
	readonly repository: string;
	readonly stderr: GitStderr;
}

/** A revision, tree or object named in the arguments does not exist. */
export interface BadRevision {
	readonly kind: 'BadRevision';
	readonly args: readonly string[];
	readonly stderr: GitStderr;
}

/**
 * An object git needed is not in the repository and could not be fetched: in a
 * partial clone the promisor remote could not be reached or does not have it,
 * otherwise the repository is damaged.
 */
export interface MissingObject {
	readonly kind: 'MissingObject';
	/** The object id, when git named it. */
	readonly object: string | undefined;
	readonly stderr: GitStderr;
}

/** The installed git is older than the oldest release diff delver works with. */
export interface GitTooOld {
	readonly kind: 'GitTooOld';
	readonly found: GitVersion;
	readonly needed: GitVersion;
}

/** git ran and failed for another reason. */
export interface GitFailed {
	readonly kind: 'GitFailed';
	readonly args: readonly string[];
	/** Absent when git did not run to an exit: it could not be started, or a signal stopped it. */
	readonly exitCode: ExitCode | undefined;
	readonly stderr: GitStderr;
}

export type GitError =
	| GitNotFound
	| GitTooOld
	| NotARepository
	| DubiousOwnership
	| BadRevision
	| MissingObject
	| GitFailed;

const DUBIOUS_OWNERSHIP = /detected dubious ownership in repository at '([^\n]*)'/;

const NOT_A_REPOSITORY = /not a git repository/i;
/** What git says when an object it needs is absent, with the id where it gives one. */
const MISSING_OBJECT =
	/unable to read (?:tree |blob )?\(?([0-9a-f]{40,64})|could not fetch ([0-9a-f]{40,64}) from promisor remote|missing (?:blob|tree|commit) object '?([0-9a-f]{40,64})/i;
const BAD_REVISION =
	/bad revision|unknown revision|needed a single revision|bad object|not a valid object name|not a tree object|invalid object name|ambiguous argument/i;

/** The environment every git run gets: the parent's, minus git's own variables. */
function gitEnv(command: GitCommand): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (!name.startsWith('GIT_')) env[name] = value;
	}
	const isolation =
		command.config === 'reviewer'
			? {}
			: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_ATTR_NOSYSTEM: '1' };
	return {
		...env,
		...isolation,
		GIT_TERMINAL_PROMPT: '0',
		GIT_PAGER: 'cat',
		GIT_OPTIONAL_LOCKS: '0',
		LC_ALL: 'C',
		LANGUAGE: 'C',
		...command.env,
		...(command.config === 'reviewer' ? { GIT_NO_LAZY_FETCH: '1' } : {})
	};
}

/** The version check, made once per process when git is first run. */
let versionChecked: Promise<GitTooOld | undefined> | undefined;

/** The installed git's version, as `git --version` gives it. */
export async function installedGitVersion(): Promise<Result<GitVersion, GitError>> {
	const ran = await spawnGit({ cwd: anyDirectory(), args: ['--version'] });
	if (!ran.ok) return ran;
	const text = ran.value.stdout.toString('utf8');
	const version = parseGitVersion(text);
	return version.ok
		? ok(version.value)
		: err({
				kind: 'GitFailed',
				args: ['--version'],
				exitCode: undefined,
				stderr: gitStderr(`git --version printed "${text.trim()}"`)
			});
}

/** `GitTooOld` if the installed git is too old; undefined if it is new enough, or its version cannot be read. */
function checkGitVersion(): Promise<GitTooOld | undefined> {
	versionChecked ??= installedGitVersion().then((version) => {
		// Not cached when git is missing, so installing it needs no restart.
		if (!version.ok && version.error.kind === 'GitNotFound') versionChecked = undefined;
		return version.ok && !isAtLeast(version.value, MINIMUM_GIT_VERSION)
			? { kind: 'GitTooOld', found: version.value, needed: MINIMUM_GIT_VERSION }
			: undefined;
	});
	return versionChecked;
}

/** A directory that exists, for a command that needs no repository. */
function anyDirectory(): AbsolutePath {
	const dir = parseAbsolutePath(tmpdir());
	if (!dir.ok) throw new Error('The temporary directory is not absolute');
	return dir.value;
}

/**
 * Runs one git command to completion and returns its output, or why it failed.
 * The first run in a process checks that git is new enough (`GitTooOld`).
 */
export async function runGit(command: GitCommand): Promise<Result<GitOutput, GitError>> {
	const tooOld = await checkGitVersion();
	if (tooOld !== undefined) return err(tooOld);
	const directory = await stat(command.cwd).catch(() => undefined);
	if (directory?.isDirectory() !== true) {
		return err({ kind: 'NotARepository', directory: command.cwd, stderr: gitStderr('') });
	}
	return spawnGit(command);
}

function spawnGit(command: GitCommand): Promise<Result<GitOutput, GitError>> {
	return new Promise((resolve) => {
		const child = spawn('git', command.args, {
			cwd: command.cwd,
			env: gitEnv(command),
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
			else resolve(err(failed(command, undefined, gitStderr(error.message))));
		});
		child.on('close', (code) => {
			const errText = gitStderr(Buffer.concat(stderr).toString('utf8'));
			const dubious = DUBIOUS_OWNERSHIP.exec(errText);
			if (code === 0) {
				resolve(ok({ stdout: Buffer.concat(stdout), stderr: errText }));
			} else if (dubious !== null) {
				const repository = dubious[1] ?? command.cwd;
				resolve(err({ kind: 'DubiousOwnership', repository, stderr: errText }));
			} else if (NOT_A_REPOSITORY.test(errText)) {
				resolve(err({ kind: 'NotARepository', directory: command.cwd, stderr: errText }));
			} else if (MISSING_OBJECT.test(errText)) {
				const match = MISSING_OBJECT.exec(errText);
				// Only the group of the phrase that matched holds the id.
				const ids: readonly (string | undefined)[] = match?.slice(1) ?? [];
				const object = ids.find((id) => id !== undefined);
				resolve(err({ kind: 'MissingObject', object, stderr: errText }));
			} else if (BAD_REVISION.test(errText)) {
				resolve(err({ kind: 'BadRevision', args: command.args, stderr: errText }));
			} else {
				const exitCode = code === null ? undefined : parseExitCode(code);
				resolve(err(failed(command, exitCode?.ok === true ? exitCode.value : undefined, errText)));
			}
		});
	});
}

function failed(command: GitCommand, exitCode: ExitCode | undefined, stderr: GitStderr): GitFailed {
	return { kind: 'GitFailed', args: command.args, exitCode, stderr };
}

/** Runs a git command and returns its stdout as text, without a trailing newline. */
export async function runGitText(command: GitCommand): Promise<Result<string, GitError>> {
	const result = await runGit(command);
	return result.ok ? ok(result.value.stdout.toString('utf8').replace(/\n$/, '')) : result;
}

/** What happened and what to do next, for the reviewer. */
export function describeGitError(error: GitError): ReviewerMessage {
	return reviewerMessage(gitErrorText(error));
}

function gitErrorText(error: GitError): string {
	switch (error.kind) {
		case 'GitNotFound':
			return `git could not be found. Install git ${MINIMUM_GIT_VERSION} or newer and make sure it is on your PATH, then try again.`;
		case 'GitTooOld':
			return `diff delver needs git ${error.needed} or newer; this is git ${error.found}. Install a newer git (https://git-scm.com/downloads lists where to get one for your system), then try again.`;
		case 'NotARepository':
			return `${error.directory} is not a git repository. Run diff delver inside a repository, or pass its path.`;
		case 'DubiousOwnership':
			return `git refuses to work in ${error.repository} because the folder belongs to another user account on this computer. If you trust it, allow it with: git config --global --add safe.directory '${error.repository}' Then try again.`;
		case 'BadRevision':
			return `git does not know one of the revisions asked for: ${firstLineOf(error.stderr)} Check the name, or fetch it first.`;
		case 'MissingObject': {
			const which = error.object === undefined ? 'an object' : `the object ${error.object}`;
			return `git could not read ${which}: it is not in the repository, and it could not be fetched (${firstLineOf(error.stderr)}). If the repository is a partial clone, check that its remote can be reached, for example with "git fetch", then try again. Otherwise the repository may be damaged: "git fsck" says what is missing.`;
		}
		case 'GitFailed': {
			const how =
				error.exitCode === undefined
					? 'it stopped before it could finish'
					: `exit code ${error.exitCode}`;
			return `git ${error.args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''} failed (${how}): ${firstLineOf(error.stderr)} Check that git works in this repository, for example with "git status", then try again.`;
		}
	}
}
