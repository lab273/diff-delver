/**
 * The daemon's lockfile (DESIGN 3, 9): `daemon.lock` in the data folder, which
 * says that a daemon serves this data folder, where (its port), which process
 * it is, its token, and which build of diff delver it runs. One daemon per data
 * folder: a daemon takes the lock before it serves anything and removes it when
 * it stops.
 *
 * The file is made whole or not at all: written under a private name, then
 * linked to `daemon.lock`, which fails if a lockfile is already there. Only the
 * owner can read it, since it holds the token.
 */
import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseCodeVersion, type CodeVersion } from '#lib/core/code-version.tiny.ts';
import { parseDaemonToken, type DaemonToken } from '#lib/core/daemon-token.tiny.ts';
import { parsePortNumber, type PortNumber } from '#lib/core/port-number.tiny.ts';
import { parseProcessId, type ProcessId } from '#lib/core/process-id.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { parseTimestamp, type Timestamp } from '#lib/core/timestamp.tiny.ts';

export const LOCKFILE_NAME = 'daemon.lock';

export interface Lock {
	readonly port: PortNumber;
	readonly pid: ProcessId;
	readonly token: DaemonToken;
	readonly version: CodeVersion;
	readonly startedAt: Timestamp;
}

function parsed<I, T>(base: z.ZodType<I>, parse: (value: I) => Result<T, unknown>): z.ZodType<T> {
	return base.transform((value, context) => {
		const result = parse(value);
		if (result.ok) return result.value;
		context.addIssue({ code: 'custom', message: 'not valid here' });
		return z.NEVER;
	});
}

const LockSchema = z.object({
	port: parsed(z.number(), parsePortNumber),
	pid: parsed(z.number(), parseProcessId),
	token: parsed(z.string(), parseDaemonToken),
	version: parsed(z.string(), parseCodeVersion),
	startedAt: parsed(z.number(), parseTimestamp)
});

export function lockfilePath(dataDirectory: AbsolutePath): string {
	return join(dataDirectory, LOCKFILE_NAME);
}

/** What is in the lockfile: a lock, nothing, or something that is not one, such as a half-written file. */
export type LockfileContent =
	| { readonly kind: 'none' }
	| { readonly kind: 'lock'; readonly lock: Lock; readonly text: string }
	| { readonly kind: 'unreadable'; readonly text: string };

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && 'code' in error && typeof error.code === 'string'
		? error.code
		: undefined;
}

export async function readLockfile(dataDirectory: AbsolutePath): Promise<LockfileContent> {
	let text: string;
	try {
		text = await readFile(lockfilePath(dataDirectory), 'utf8');
	} catch (error) {
		// No data folder, or a file where it should be: no lock. Starting a daemon
		// there says what is wrong with the folder.
		const code = errorCode(error);
		if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'none' };
		throw error;
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return { kind: 'unreadable', text };
	}
	const lock = LockSchema.safeParse(json);
	return lock.success ? { kind: 'lock', lock: lock.data, text } : { kind: 'unreadable', text };
}

/** The data folder could not be made or written to. */
export interface DataDirectoryNotWritable {
	readonly kind: 'DataDirectoryNotWritable';
	readonly directory: AbsolutePath;
	readonly reason: string;
}

/**
 * Takes the lock: writes `lock` as the lockfile unless there is one already,
 * in which case it says so and writes nothing.
 */
export async function takeLock(
	dataDirectory: AbsolutePath,
	lock: Lock
): Promise<Result<'taken' | 'held', DataDirectoryNotWritable>> {
	const path = lockfilePath(dataDirectory);
	const pending = `${path}.${randomBytes(8).toString('hex')}.pending`;
	const notWritable = (error: unknown): Result<never, DataDirectoryNotWritable> =>
		err({
			kind: 'DataDirectoryNotWritable',
			directory: dataDirectory,
			reason: error instanceof Error ? error.message : String(error)
		});
	try {
		await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
		await writeFile(pending, lockText(lock), { mode: 0o600, flag: 'wx' });
	} catch (error) {
		return notWritable(error);
	}
	try {
		await link(pending, path);
		return ok('taken');
	} catch (error) {
		if (errorCode(error) === 'EEXIST') return ok('held');
		return notWritable(error);
	} finally {
		await rm(pending, { force: true });
	}
}

/**
 * Removes the lockfile if it still holds exactly `text`, so a daemon never
 * removes a lock another one has taken since.
 */
export async function removeLockfileIf(dataDirectory: AbsolutePath, text: string): Promise<void> {
	const now = await readLockfile(dataDirectory);
	if (now.kind !== 'none' && now.text === text)
		await rm(lockfilePath(dataDirectory), { force: true });
}

/** The lock's text, as `takeLock` writes it, to compare with `removeLockfileIf`. */
export function lockText(lock: Lock): string {
	return `${JSON.stringify(lock)}\n`;
}
