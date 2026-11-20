/**
 * How the command finds the daemon of its data folder, starting one when there
 * is none (DESIGN 3):
 *
 * - a lockfile whose daemon answers, with the command's own version: used;
 * - one whose daemon answers with another version: that daemon is asked to stop
 *   and a new one is started, so a person who updated diff delver is never left
 *   talking to the old one. Its open pages stop working, and the command says so;
 * - a stale lockfile (its process is gone, or it does not answer) or none: a
 *   new daemon is started, which replaces the stale lockfile. A process a stale
 *   lockfile names is never signalled: it may be any program by now.
 *
 * A new daemon is `diff-delver serve` run in the background, detached from the
 * terminal, writing to `daemon.log` in the data folder. It says over an IPC
 * channel when it is listening, or why it could not start, so the command waits
 * for exactly that and no longer.
 */
import { spawn } from 'node:child_process';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import type { CodeVersion } from '#lib/core/code-version.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { connectionOf, type DaemonConnection } from './daemon.ts';
import { readLockfile, removeLockfileIf, type Lock } from './lockfile.ts';
import { clientFor, probeLock } from './probe.ts';

export const LOG_NAME = 'daemon.log';

/** What a background daemon says over its IPC channel once it is up, or has given up. */
export const ReadySignalSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('ready') }),
	z.object({ kind: z.literal('failed'), message: z.string() })
]);
export type ReadySignal = z.output<typeof ReadySignalSchema>;

export type LaunchError =
	| { readonly kind: 'StartFailed'; readonly message: ReviewerMessage }
	| { readonly kind: 'OldDaemonWouldNotStop'; readonly lock: Lock };

export function describeLaunchError(error: LaunchError): ReviewerMessage {
	switch (error.kind) {
		case 'StartFailed':
			return error.message;
		case 'OldDaemonWouldNotStop':
			return reviewerMessage(
				`A different version of diff delver is running (process ${String(error.lock.pid)}) and would not stop. Stop it with diff-delver stop, or end that process, then try again.`
			);
	}
}

export interface Launched {
	readonly connection: DaemonConnection;
	/** What happened to an earlier daemon, for the command to say. */
	readonly replaced: 'other-version' | undefined;
}

/** How long a new daemon has to say it is listening. */
const START_WITHIN_MS = 30_000;

/** How long an old daemon has to stop when asked. */
const STOP_WITHIN_MS = 5_000;

/** Waits until the lockfile no longer holds `text`, or the time is up. */
async function lockReleased(
	dataDirectory: AbsolutePath,
	text: string,
	withinMs: number
): Promise<boolean> {
	const until = Date.now() + withinMs;
	for (;;) {
		const now = await readLockfile(dataDirectory);
		if (now.kind === 'none' || now.text !== text) return true;
		if (Date.now() > until) return false;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/**
 * Asks the daemon of `lock` to stop and waits for it to; ends its process if it
 * will not. The process is signalled only while a daemon answers at the
 * lockfile's port with its token and process id: a process the lockfile names
 * that does not answer may be any program that has since been given that id,
 * and is never touched. When nothing answers, the lockfile is stale and goes.
 */
export async function stopDaemonOf(
	dataDirectory: AbsolutePath,
	lock: Lock,
	text: string
): Promise<boolean> {
	await clientFor(lock).stopDaemon();
	if (await lockReleased(dataDirectory, text, STOP_WITHIN_MS)) return true;
	if ((await probeLock(lock)).kind === 'answering') {
		try {
			process.kill(lock.pid, 'SIGTERM');
		} catch {
			// Gone meanwhile.
		}
		if (await lockReleased(dataDirectory, text, STOP_WITHIN_MS)) return true;
		if ((await probeLock(lock)).kind === 'answering') return false;
	}
	await removeLockfileIf(dataDirectory, text);
	return true;
}

/** Starts `diff-delver serve` in the background and waits for it to listen. */
async function spawnDaemon(
	dataDirectory: AbsolutePath,
	entry: string
): Promise<Result<void, LaunchError>> {
	const failed = (message: string): Result<never, LaunchError> =>
		err({ kind: 'StartFailed', message: reviewerMessage(message) });
	let log: FileHandle;
	try {
		await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
		log = await open(join(dataDirectory, LOG_NAME), 'a', 0o600);
	} catch (error) {
		return failed(
			`diff delver could not write to its data folder ${dataDirectory} (${error instanceof Error ? error.message : String(error)}). Check that you can write there, or choose another folder with --data-directory, then try again.`
		);
	}
	try {
		const child = spawn(process.execPath, [entry, 'serve', '--data-directory', dataDirectory], {
			detached: true,
			stdio: ['ignore', log.fd, log.fd, 'ipc'],
			windowsHide: true
		});
		const signal = await new Promise<ReadySignal | 'exited' | 'timed-out'>((resolve) => {
			const timer = setTimeout(() => {
				resolve('timed-out');
			}, START_WITHIN_MS);
			child.once('message', (message) => {
				clearTimeout(timer);
				const parsed = ReadySignalSchema.safeParse(message);
				resolve(parsed.success ? parsed.data : 'exited');
			});
			child.once('exit', () => {
				clearTimeout(timer);
				resolve('exited');
			});
			child.once('error', () => {
				clearTimeout(timer);
				resolve('exited');
			});
		});
		if (child.connected) child.disconnect();
		child.unref();
		const logPath = join(dataDirectory, LOG_NAME);
		if (signal === 'exited') {
			return failed(`diff delver stopped while it was starting. What it wrote is in ${logPath}.`);
		}
		if (signal === 'timed-out') {
			child.kill();
			return failed(
				`diff delver took too long to start. What it wrote is in ${logPath}; try again in a moment.`
			);
		}
		switch (signal.kind) {
			case 'ready':
				return ok(undefined);
			case 'failed':
				return failed(signal.message);
		}
	} finally {
		await log.close();
	}
}

/** The daemon of `dataDirectory` that runs `version`, started if need be. */
export async function ensureDaemon(
	dataDirectory: AbsolutePath,
	version: CodeVersion,
	entry: string
): Promise<Result<Launched, LaunchError>> {
	let replaced: Launched['replaced'];
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const content = await readLockfile(dataDirectory);
		if (content.kind === 'lock') {
			const probe = await probeLock(content.lock);
			if (probe.kind === 'answering') {
				if (probe.version === version) {
					return ok({ connection: connectionOf(content.lock), replaced });
				}
				if (!(await stopDaemonOf(dataDirectory, content.lock, content.text))) {
					return err({ kind: 'OldDaemonWouldNotStop', lock: content.lock });
				}
				replaced = 'other-version';
				continue;
			}
		}
		// None, stale or unreadable: a new daemon replaces it. If another command
		// started one meanwhile, the new one finds it and stops; it is used instead.
		const started = await spawnDaemon(dataDirectory, entry);
		if (!started.ok) return started;
	}
	const content = await readLockfile(dataDirectory);
	if (content.kind === 'lock') return ok({ connection: connectionOf(content.lock), replaced });
	return err({
		kind: 'StartFailed',
		message: reviewerMessage(
			`diff delver started but left no lockfile in ${dataDirectory}. Try again; if it keeps happening, look in ${join(dataDirectory, LOG_NAME)}.`
		)
	});
}

/**
 * What `diff-delver stop` did: stopped a daemon; found none; found a stale
 * lockfile, which it removed without signalling anything; or found a daemon
 * that would not stop.
 */
export type StopOutcome = 'stopped' | 'not-running' | 'stale' | 'would-not-stop';

export async function stopDaemon(dataDirectory: AbsolutePath): Promise<StopOutcome> {
	const content = await readLockfile(dataDirectory);
	if (content.kind !== 'lock') return 'not-running';
	if ((await probeLock(content.lock)).kind === 'gone') {
		await removeLockfileIf(dataDirectory, content.text);
		return 'stale';
	}
	return (await stopDaemonOf(dataDirectory, content.lock, content.text))
		? 'stopped'
		: 'would-not-stop';
}
