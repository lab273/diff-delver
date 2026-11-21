/**
 * Daemons for integration tests: started in the test's own process on the real
 * app (`build/handler.js`, made by the integration project's global setup),
 * with a temporary data folder and a reviewer git setup of the test's own, and
 * stopped when the test finishes. Also a plain HTTP request, for the checks on
 * `Host`, `Origin` and the token, which `fetch` will not let a test set freely.
 */
import { request as httpRequest } from 'node:http';
import { onTestFinished } from 'vitest';
import { ApiClient } from '#lib/api/client.ts';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { settableClock, type SettableClock } from '#lib/core/clock.ts';
import { parseCodeVersion, type CodeVersion } from '#lib/core/code-version.tiny.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { parseTimestamp } from '#lib/core/timestamp.tiny.ts';
import { loadAppHandler, type AppHandler } from '#lib/server/daemon/app-handler.ts';
import {
	startDaemon,
	type DaemonStartError,
	type RunningDaemon
} from '#lib/server/daemon/daemon.ts';
import type { Result } from '#lib/core/result.ts';
import { tempDirectory } from './fixture-repos.ts';
import { reviewer, type Reviewer } from './reviewer-git.ts';

let app: Promise<AppHandler> | undefined;

export function version(text: string): CodeVersion {
	const parsed = parseCodeVersion(text);
	if (!parsed.ok) throw new Error(`Not a version: ${text}`);
	return parsed.value;
}

export interface TestDaemonOptions {
	readonly dataDirectory?: AbsolutePath;
	readonly version?: CodeVersion;
	readonly who?: Reviewer;
	/** How the daemon runs its lockfile check; by default, as the command's does. */
	readonly repeat?: (check: () => Promise<void>) => () => void;
	/** The daemon's clock; by default one fixed at a time in 2026. */
	readonly clock?: SettableClock;
	/** What the daemon opens a browser with, for an agent's new report; by default it never does. */
	readonly openBrowser?: (address: string) => Promise<boolean>;
}

/** Starts a daemon, or says why it could not; one that starts is stopped when the test finishes. */
export async function tryStartDaemon(
	options: TestDaemonOptions = {}
): Promise<Result<RunningDaemon, DaemonStartError>> {
	app ??= loadAppHandler();
	const time = parseTimestamp(Date.UTC(2026, 0, 15, 9, 30));
	if (!time.ok) throw new Error('bad time');
	const clock = options.clock ?? settableClock(time.value);
	const who = options.who ?? (await reviewer());
	const started = await startDaemon({
		dataDirectory: options.dataDirectory ?? (await tempDirectory()),
		clock,
		ids: sequentialIds(),
		version: options.version ?? version('test'),
		app: await app,
		repository: { gitEnv: who.gitEnv },
		...(options.repeat === undefined ? {} : { repeat: options.repeat }),
		...(options.openBrowser === undefined ? {} : { openBrowser: options.openBrowser })
	});
	if (started.ok) {
		const daemon = started.value;
		onTestFinished(() => daemon.stop());
	}
	return started;
}

export async function testDaemon(options: TestDaemonOptions = {}): Promise<RunningDaemon> {
	const started = await tryStartDaemon(options);
	if (!started.ok) throw new Error(`The daemon did not start: ${JSON.stringify(started.error)}`);
	return started.value;
}

/** The typed client for a daemon, as the command uses it. */
export function clientOf(daemon: Pick<RunningDaemon, 'origin' | 'token'>): ApiClient {
	return new ApiClient({ fetch, base: daemon.origin, token: daemon.token });
}

/** Redeem a single-use entry code and keep the cookie the real browser would send. */
export async function browserCookie(daemon: RunningDaemon): Promise<string> {
	const response = await rawRequest(daemon.port, { path: `/?entry=${daemon.entryCode()}` });
	const header = response.headers['set-cookie']?.[0];
	const cookie = header?.split(';', 1)[0];
	if (response.status !== 303 || cookie === undefined)
		throw new Error('The browser was not let in');
	return cookie;
}

export async function browserClient(daemon: RunningDaemon): Promise<ApiClient> {
	const cookie = await browserCookie(daemon);
	return new ApiClient({
		base: daemon.origin,
		fetch: (input, init) => {
			const headers = new Headers(init?.headers);
			headers.set('cookie', cookie);
			if (init?.method !== 'GET') headers.set('origin', daemon.origin);
			return fetch(input, { ...init, headers });
		}
	});
}

export interface RawResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
	readonly body: string;
}

/** One HTTP request with exactly these headers, `Host` included. */
export function rawRequest(
	port: number,
	options: {
		readonly method?: string;
		readonly path: string;
		readonly headers?: Readonly<Record<string, string>>;
		readonly body?: string;
	}
): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				host: '127.0.0.1',
				port,
				method: options.method ?? 'GET',
				path: options.path,
				headers: { host: `127.0.0.1:${String(port)}`, ...options.headers }
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks).toString('utf8')
					});
				});
			}
		);
		req.on('error', reject);
		req.end(options.body);
	});
}
