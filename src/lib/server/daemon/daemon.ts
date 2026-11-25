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
 * version replaces it. It also stops when its lockfile is gone or holds another
 * daemon's entry, as when its data folder was deleted, since then no command
 * could find it or stop it: it checks every few seconds (`LOCK_CHECK_EVERY_MS`).
 * With the same check, once at least `TIDY_STORES_EVERY_MS` has passed by its
 * clock since it last did, it tidies the stores (`ReportService.tidyStores`),
 * so the objects of snapshots it took and did not keep do not pile up until it
 * next starts.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import {
	copyOf,
	dataDirectoryToName,
	type AgentServerSetup
} from '#lib/core/agent-setup/agent-server.ts';
import type { Clock } from '#lib/core/clock.ts';
import type { CodeVersion } from '#lib/core/code-version.tiny.ts';
import { isToken, parseDaemonToken, type DaemonToken } from '#lib/core/daemon-token.tiny.ts';
import { agentActivity } from '#lib/core/daemon/agent-activity.ts';
import { entryCodes, type BrowserGrant } from '#lib/core/daemon/entry-codes.ts';
import { reviewWindows, type ReviewWindowOutcome } from '#lib/core/daemon/review-windows.ts';
import {
	cookieValue,
	ENTRY_PARAMETER,
	reviewCookieName,
	type GateSettings
} from '#lib/core/daemon/request-gate.ts';
import type { EntryCode } from '#lib/core/entry-code.tiny.ts';
import type { IdSource } from '#lib/core/ids.ts';
import { parsePortNumber, type PortNumber } from '#lib/core/port-number.tiny.ts';
import { parseProcessId } from '#lib/core/process-id.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { timeBetween } from '#lib/core/timestamp.tiny.ts';
import { GRACE_PERIOD } from '../store/index.ts';
import type { DatabaseError } from '../db/index.ts';
import { describeDatabaseError } from '../db/index.ts';
import { ReportService, describeReportError } from '../reports/index.ts';
import type { RepositoryOptions } from '../sources/git/index.ts';
import { randomEntryCode } from '../system.ts';
import type { AppHandler } from './app-handler.ts';
import { registerDaemon, unregisterDaemon } from './context.ts';
import { browserAccess } from './browser-access.ts';
import { daemonServer } from './http-server.ts';
import { mcpHandler } from '../mcp/mcp-server.ts';
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
	/**
	 * Opens an address in the person's browser, for an agent's `create_report`
	 * through a shim that asks for it; whether it could. The address lets that
	 * browser write the person's drafts, so it goes nowhere else. The command
	 * gives the system's opener; tests give none, so no browser ever opens.
	 */
	readonly openBrowser?: (address: string) => Promise<boolean>;
	/**
	 * What the starter knows of the machine and of how this copy was run, for the
	 * command a page gives a person to connect their agent (`agent-server.ts`).
	 * The command gives them all. Left out, the daemon takes its data folder for
	 * one that must be named and itself for a copy the release's command runs.
	 */
	readonly machine?: MachineFacts;
	/** Called once the daemon has stopped, however it was asked to. */
	readonly onStopped?: () => void;
	/**
	 * Runs `check` from time to time until the function it returns is called: by
	 * default every `LOCK_CHECK_EVERY_MS`. A test gives its own, to run the check
	 * when it chooses instead of waiting.
	 */
	readonly repeat?: (check: () => Promise<void>) => () => void;
}

export interface MachineFacts {
	/** The file the command was run by (`node <entry> serve`), which runs this same copy again. */
	readonly entry?: AbsolutePath | undefined;
	/** The Node program the daemon runs on, which runs `entry` again whatever `node` an agent finds. */
	readonly node?: AbsolutePath | undefined;
	/** This machine's default data folder: a daemon on it needs no `--data-directory`. */
	readonly defaultDataDirectory?: AbsolutePath | undefined;
	/** The person's home folder. */
	readonly home?: AbsolutePath | undefined;
}

/** How an agent is given the daemon that `options` describe. */
export function agentSetupOf(
	options: Pick<DaemonOptions, 'dataDirectory' | 'version' | 'machine'>
): AgentServerSetup {
	return {
		copy: copyOf(options.version, options.machine?.entry, options.machine?.node),
		dataDirectory: dataDirectoryToName(
			options.dataDirectory,
			options.machine?.defaultDataDirectory
		),
		home: options.machine?.home
	};
}

/** How often a daemon checks that its lockfile is still there and still its own. */
export const LOCK_CHECK_EVERY_MS = 5000;

/**
 * How long, by the daemon's clock, between tidying its stores: the grace period
 * the store keeps unreferenced objects for, since nothing younger is collected.
 */
export const TIDY_STORES_EVERY_MS = GRACE_PERIOD;

function everyFewSeconds(check: () => Promise<void>): () => void {
	const timer = setInterval(() => {
		void check();
	}, LOCK_CHECK_EVERY_MS);
	timer.unref();
	return () => {
		clearInterval(timer);
	};
}

/** Where a running daemon is, and how to reach it. */
export interface DaemonConnection {
	readonly port: PortNumber;
	readonly token: DaemonToken;
	readonly mcpToken?: DaemonToken | undefined;
	/** `http://127.0.0.1:<port>`. */
	readonly origin: string;
}

export interface RunningDaemon extends DaemonConnection {
	readonly mcpToken: DaemonToken;
	readonly lock: Lock;
	/** The name of the cookie a browser that may write drafts holds. */
	readonly reviewCookie: string;
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

export function connectionOf(lock: Pick<Lock, 'port' | 'token' | 'mcpToken'>): DaemonConnection {
	return {
		port: lock.port,
		token: lock.token,
		...(lock.mcpToken === undefined ? {} : { mcpToken: lock.mcpToken }),
		origin: `http://127.0.0.1:${String(lock.port)}`
	};
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
	const codes = entryCodes();
	const issue = (grant: BrowserGrant): EntryCode => {
		const code = randomEntryCode();
		codes.issue(code, grant);
		return code;
	};
	// Set once the port is known, before anything is served.
	const origin = { value: '' };
	const openBrowser = options.openBrowser ?? (() => Promise.resolve(false));
	/**
	 * Opens a page in the person's own browser with review access: the one way a
	 * browser gets it without the command (DESIGN 9). The rule it keeps is that
	 * the person's drafts have no path an agent can write, so what matters is who
	 * receives the grant, not who asked. Whoever asks (an agent's `create_report`
	 * through MCP, or a page that has only a view grant) gives a page and is told
	 * only whether a window was asked for. The code is made here, goes to the
	 * system's opener and so to the browser of the person at this machine, works
	 * once, and is never in an answer, a header or the log. A caller can at most
	 * make a window appear in front of the person, and at most one every few
	 * seconds (`review-windows.ts`), since each starts a program.
	 */
	const windows = reviewWindows(options.clock);
	// The agents heard from on /mcp: in memory only, and gone with the daemon.
	const agents = agentActivity(options.clock);
	const openForReview = async (page: string): Promise<ReviewWindowOutcome> => {
		if (!windows.mayAsk()) return 'too-soon';
		const opened = await openBrowser(entryAddress(origin.value, page, issue('review')));
		return opened ? 'opened' : 'no-browser';
	};
	const server = daemonServer(
		options.app,
		() => gate.settings,
		mcpHandler({
			service,
			version: options.version,
			agents,
			entryAddress: (page) => entryAddress(origin.value, page, issue('view')),
			open: async (page) => (await openForReview(page)) === 'opened'
		})
	);
	const port = await listen(server);
	if (!port.ok) {
		service.close();
		return port;
	}
	origin.value = `http://127.0.0.1:${String(port.value)}`;
	const pid = parseProcessId(process.pid);
	if (!pid.ok) throw new Error('This process has no id.');
	const mcpToken = newToken();
	const lock: Lock = {
		port: port.value,
		pid: pid.value,
		token: newToken(),
		mcpToken,
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
	let stopChecking = (): void => undefined;
	let lastTidy = options.clock.now();
	let tidying: Promise<void> | undefined;
	const tidyIfDue = async (): Promise<void> => {
		const now = options.clock.now();
		if (tidying !== undefined || timeBetween(lastTidy, now) < TIDY_STORES_EVERY_MS) return;
		lastTidy = now;
		tidying = service.tidyStores().then((tidied) => {
			tidying = undefined;
			if (!tidied.ok) {
				console.error(
					`diff delver could not tidy its saved changes: ${describeReportError(tidied.error)}`
				);
			}
		});
		await tidying;
	};
	const stop = (): Promise<void> => {
		stopping ??= (async () => {
			stopChecking();
			unregisterDaemon(lock.port);
			await close(server);
			await cleaned;
			await tidying;
			service.close();
			await removeLockfileIf(options.dataDirectory, lockText(lock));
			markStopped();
			options.onStopped?.();
		})();
		return stopping;
	};

	// The data folder's, so a browser that may write drafts still may after a restart.
	const browser = await browserAccess(options.dataDirectory);
	if (browser.notKept !== undefined) {
		console.error(
			`diff delver could not keep its browser access in ${options.dataDirectory} (${browser.notKept}), so browsers will need letting in again after it next starts.`
		);
	}
	const reviewCookie = reviewCookieName(browser.id);
	const viewToken = newToken();
	const entryCode = (): EntryCode => issue('review');
	registerDaemon(lock.port, {
		isReviewBrowser: (header) => {
			const token = cookieValue(header, reviewCookie);
			return token !== undefined && isToken(browser.token, token);
		},
		isCommand: (authorization) => {
			const bearer = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
			return bearer !== undefined && isToken(lock.token, bearer);
		},
		service,
		clock: options.clock,
		version: options.version,
		agentSetup: agentSetupOf(options),
		agents,
		entryCode,
		openForReview,
		requestStop: () => {
			// After the answer saying so has gone.
			setTimeout(() => {
				void stop();
			}, 0);
		}
	});
	// Its lockfile gone or another's: nothing could find or stop this daemon, so it stops.
	const text = lockText(lock);
	stopChecking = (options.repeat ?? everyFewSeconds)(async () => {
		const now = await readLockfile(options.dataDirectory).catch(() => undefined);
		if (now === undefined || stopping !== undefined) return;
		if (now.kind === 'none' || now.text !== text) {
			console.log(
				`diff delver is stopping: its lockfile in ${options.dataDirectory} is gone or belongs to another diff delver, so nothing else could find or stop it.`
			);
			await stop();
			return;
		}
		await tidyIfDue();
	});
	gate.settings = {
		port: lock.port,
		token: lock.token,
		mcpToken,
		browserId: browser.id,
		browserToken: browser.token,
		viewToken,
		redeemEntryCode: (given) => codes.redeem(given)
	};
	return ok({
		...connectionOf(lock),
		mcpToken,
		lock,
		reviewCookie,
		entryCode,
		cleaned,
		stop,
		stopped
	});
}
