/**
 * The daemon (DESIGN 3, 9): one per data folder, serving the app and its API on
 * 127.0.0.1 at a free port, behind the request gate. Starting it:
 *
 * 1. opens the report service for the data folder;
 * 2. listens on a free port of 127.0.0.1;
 * 3. takes the lock (`lockfile.ts`), replacing a stale one: a lockfile whose
 *    daemon is gone or does not answer with its token. If another daemon holds
 *    it and answers, this one closes again and says so;
 * 4. registers itself for the app's routes (`context.ts`), and starts removing
 *    snapshots a crash left behind, without waiting for that.
 *
 * Time and ids come from the `clock` and `ids` it is given. The command always
 * gives the real ones (`#lib/server/system.ts`); only tests and journeys, which
 * start a daemon in their own process with this function, give fixed ones.
 * There is no switch, flag or variable that does it, so it cannot be turned on
 * by accident.
 *
 * It does not stop by itself when idle: it holds nothing that is not on disk,
 * but a page left open would stop working with the browser's own error. It
 * stops on `diff-delver stop`, on a signal, or when a command of another
 * version replaces it.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import type { Clock } from '#lib/core/clock.ts';
import type { CodeVersion } from '#lib/core/code-version.tiny.ts';
import { parseDaemonToken, type DaemonToken } from '#lib/core/daemon-token.tiny.ts';
import { entryCodes } from '#lib/core/daemon/entry-codes.ts';
import { ENTRY_PARAMETER, type GateSettings } from '#lib/core/daemon/request-gate.ts';
import type { EntryCode } from '#lib/core/entry-code.tiny.ts';
import type { IdSource } from '#lib/core/ids.ts';
import { parsePortNumber, type PortNumber } from '#lib/core/port-number.tiny.ts';
import { parseProcessId } from '#lib/core/process-id.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import type { DatabaseError } from '../db/index.ts';
import { describeDatabaseError } from '../db/index.ts';
import { ReportService, describeReportError } from '../reports/index.ts';
import type { RepositoryOptions } from '../sources/git/index.ts';
import { randomEntryCode } from '../system.ts';
import type { AppHandler } from './app-handler.ts';
import { registerDaemon, unregisterDaemon } from './context.ts';
import { daemonServer } from './http-server.ts';
import { probeLock } from './probe.ts';
import {
	lockText,
	readLockfile,
	removeLockfileIf,
	takeLock,
	type DataDirectoryNotWritable,
	type Lock
} from './lockfile.ts';

export interface DaemonOptions {
	readonly dataDirectory: AbsolutePath;
	readonly clock: Clock;
	readonly ids: IdSource;
	readonly version: CodeVersion;
	/** The app, from the production build (`loadAppHandler`). */
	readonly app: AppHandler;
	/** How git runs in reviewed repositories; tests give their own reviewer config. */
	readonly repository?: RepositoryOptions;
	/** Called once the daemon has stopped, however it was asked to. */
	readonly onStopped?: () => void;
}

/** Where a running daemon is, and how to reach it. */
export interface DaemonConnection {
	readonly port: PortNumber;
	readonly token: DaemonToken;
	/** `http://127.0.0.1:<port>`. */
	readonly origin: string;
}

export interface RunningDaemon extends DaemonConnection {
	readonly lock: Lock;
	/** A new single-use code that lets a browser in, for an address to open (`entryAddress`). */
	entryCode(): EntryCode;
	/** The removal of snapshots a crash left behind, which starting begins. */
	readonly cleaned: Promise<void>;
	/** Stops serving, closes the database and removes the lockfile. Stopping twice is stopping once. */
	stop(): Promise<void>;
	/** Settles once the daemon has stopped. */
	readonly stopped: Promise<void>;
}

export type DaemonStartError =
	| DataDirectoryNotWritable
	| DatabaseError
	/** Another daemon serves this data folder and answers. */
	| { readonly kind: 'AlreadyRunning'; readonly lock: Lock }
	/** No port of 127.0.0.1 could be listened on. */
	| { readonly kind: 'PortUnavailable'; readonly reason: string };

export function describeDaemonStartError(error: DaemonStartError): ReviewerMessage {
	switch (error.kind) {
		case 'DataDirectoryNotWritable':
			return reviewerMessage(
				`diff delver could not write to its data folder ${error.directory} (${error.reason}). Check that you can write there, or choose another folder with --data-directory, then try again.`
			);
		case 'AlreadyRunning':
			return reviewerMessage(
				`diff delver is already running for this data folder, at ${connectionOf(error.lock).origin}. Run diff-delver to open it, or diff-delver stop to stop it.`
			);
		case 'PortUnavailable':
			return reviewerMessage(
				`diff delver could not listen on this computer’s own address, 127.0.0.1 (${error.reason}). Check that nothing such as a firewall rule blocks programs from listening there, then try again.`
			);
		case 'DatabaseUnusable':
		case 'NotADatabase':
		case 'DatabaseCorrupt':
		case 'DatabaseTooNew':
		case 'MigrationFailed':
		case 'DatabaseBusy':
		case 'StoredRowInvalid':
		case 'DatabaseFailed':
			return describeDatabaseError(error);
	}
}

export function connectionOf(lock: Pick<Lock, 'port' | 'token'>): DaemonConnection {
	return { port: lock.port, token: lock.token, origin: `http://127.0.0.1:${String(lock.port)}` };
}

/**
 * The address of a page of the daemon that lets the browser in once, with an
 * entry code: what the command opens. It never holds the token.
 */
export function entryAddress(origin: string, path: string, code: EntryCode): string {
	const separator = path.includes('?') ? '&' : '?';
	return `${origin}${path}${separator}${ENTRY_PARAMETER}=${code}`;
}

function newToken(): DaemonToken {
	const token = parseDaemonToken(randomBytes(32).toString('hex'));
	if (!token.ok) throw new Error('A random token did not parse.');
	return token.value;
}

function listen(server: Server): Promise<Result<PortNumber, DaemonStartError>> {
	return new Promise((resolve) => {
		const failed = (error: Error): void => {
			resolve(err({ kind: 'PortUnavailable', reason: error.message }));
		};
		server.once('error', failed);
		server.listen({ host: '127.0.0.1', port: 0 }, () => {
			server.off('error', failed);
			const address = server.address();
			const port = parsePortNumber(
				typeof address === 'object' && address !== null ? address.port : 0
			);
			resolve(port.ok ? ok(port.value) : err({ kind: 'PortUnavailable', reason: 'no port given' }));
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => {
			resolve();
		});
		server.closeIdleConnections();
		// A page's open connection is let finish what it is sending, then closed.
		setTimeout(() => {
			server.closeAllConnections();
		}, 1000).unref();
	});
}

/** How many times a stale lockfile is replaced before starting gives up. */
const LOCK_ATTEMPTS = 3;

/** Takes the lock, replacing stale ones; says so when a daemon that answers holds it. */
async function lockFor(
	dataDirectory: AbsolutePath,
	lock: Lock
): Promise<Result<void, DaemonStartError>> {
	for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
		const taken = await takeLock(dataDirectory, lock);
		if (!taken.ok) return taken;
		if (taken.value === 'taken') return ok(undefined);
		const held = await readLockfile(dataDirectory);
		if (held.kind === 'lock' && (await probeLock(held.lock)).kind === 'answering') {
			return err({ kind: 'AlreadyRunning', lock: held.lock });
		}
		if (held.kind !== 'none') await removeLockfileIf(dataDirectory, held.text);
	}
	return err({
		kind: 'DataDirectoryNotWritable',
		directory: dataDirectory,
		reason: 'another diff delver kept taking its lock'
	});
}

export async function startDaemon(
	options: DaemonOptions
): Promise<Result<RunningDaemon, DaemonStartError>> {
	const opened = await ReportService.open({
		dataDirectory: options.dataDirectory,
		clock: options.clock,
		ids: options.ids,
		...(options.repository === undefined ? {} : { repository: options.repository })
	});
	if (!opened.ok) return opened;
	const service = opened.value;

	// Nothing is served until the lock is taken and the daemon registered.
	const gate: { settings: GateSettings | undefined } = { settings: undefined };
	const codes = entryCodes(options.clock);
	const entryCode = (): EntryCode => {
		const code = randomEntryCode();
		codes.issue(code);
		return code;
	};
	const server = daemonServer(options.app, () => gate.settings);
	const port = await listen(server);
	if (!port.ok) {
		service.close();
		return port;
	}
	const pid = parseProcessId(process.pid);
	if (!pid.ok) throw new Error('This process has no id.');
	const lock: Lock = {
		port: port.value,
		pid: pid.value,
		token: newToken(),
		version: options.version,
		startedAt: options.clock.now()
	};
	const locked = await lockFor(options.dataDirectory, lock);
	if (!locked.ok) {
		await close(server);
		service.close();
		return locked;
	}

	let stopping: Promise<void> | undefined;
	let markStopped = (): void => undefined;
	const stopped = new Promise<void>((resolve) => {
		markStopped = resolve;
	});
	const cleaned = service.removeUnusedSnapshots().then((removed) => {
		if (!removed.ok) {
			console.error(
				`diff delver could not remove snapshots left behind: ${describeReportError(removed.error)}`
			);
		}
	});
	const stop = (): Promise<void> => {
		stopping ??= (async () => {
			unregisterDaemon(lock.port);
			await close(server);
			await cleaned;
			service.close();
			await removeLockfileIf(options.dataDirectory, lockText(lock));
			markStopped();
			options.onStopped?.();
		})();
		return stopping;
	};

	registerDaemon(lock.port, {
		service,
		clock: options.clock,
		version: options.version,
		entryCode,
		requestStop: () => {
			// After the answer saying so has gone.
			setTimeout(() => {
				void stop();
			}, 0);
		}
	});
	gate.settings = {
		port: lock.port,
		token: lock.token,
		redeemEntryCode: (given) => codes.redeem(given)
	};
	return ok({ ...connectionOf(lock), lock, entryCode, cleaned, stop, stopped });
}
