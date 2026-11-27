/**
 * `diff-delver mcp` (DESIGN 3): the stdio shim coding agents launch. It finds
 * or starts the daemon of its data folder as the command does (`ensureDaemon`),
 * and passes each MCP message from standard input to the daemon's `/mcp`, with
 * the token from the lockfile in `Authorization`, and each answer back to
 * standard output. Standard output carries only the protocol; anything for a
 * person goes to standard error.
 *
 * It tells the daemon the folder it was started in, which `create_report`
 * opens unless told another, and, unless started with `--no-open`, that a
 * report `create_report` makes may be opened in the person's browser: the
 * first one only, for the whole session (`BrowserOffer`), whichever daemon
 * serves it.
 *
 * The daemon serves MCP without sessions, so when it stops or is replaced
 * mid-session (a newer diff delver started, or `diff-delver stop`), the shim
 * finds or starts the daemon again, as the command would, and sends the message
 * again: the agent never sees it. Every write is harmless sent twice (a repeat
 * answers as a success and changes nothing more), so a message that reached
 * the old daemon before it stopped does no harm sent again. A wait for the
 * person's requests that the old daemon ended hands nothing over, and a request
 * it had handed over and not seen answered is given again with the next wait. Only when no
 * daemon can be reached does a request get an error, which says why.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	isJSONRPCRequest,
	JSONRPCMessageSchema,
	type JSONRPCMessage
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { BrowserOffer } from '#lib/core/cli/browser-offer.ts';
import type { CodeVersion } from '#lib/core/code-version.tiny.ts';
import {
	describeDatabaseNewer,
	describeNewerDaemon,
	describeReplacedDaemon
} from '#lib/core/cli/replaced-daemon.ts';
import { MCP_PATH } from '#lib/core/daemon/request-gate.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import type { DaemonConnection } from '../daemon/daemon.ts';
import { describeLaunchError, ensureDaemon, versionOnDisk } from '../daemon/launcher.ts';
import {
	browserHeader,
	DIRECTORY_HEADER,
	OPEN_BROWSER_HEADER,
	OPENED_HEADER
} from '../mcp/mcp-server.ts';

export interface ShimOptions {
	readonly dataDirectory: AbsolutePath;
	/** The folder the agent started the shim in. */
	readonly directory: AbsolutePath;
	readonly noOpen: boolean;
	readonly version: CodeVersion;
	/** The command's entry, to start a daemon with. */
	readonly entry: string;
	/** Where lines for a person go: standard error. */
	readonly printError: (line: string) => void;
}

/** How many times a message is sent before the shim gives up on reaching a daemon. */
const ATTEMPTS = 3;

/** Why a message could not be delivered, for the agent and the person. */
type Undelivered =
	/** No daemon answered, or one answered with a refusal that finding the daemon again may cure. */
	| { readonly kind: 'retry'; readonly reason: string }
	/** The daemon answered, but in a way that is no answer to MCP: sending it again would not help. */
	| { readonly kind: 'failed'; readonly reason: string }
	/** The agent cancelled the call while it was on its way: nothing is sent back. */
	| { readonly kind: 'cancelled'; readonly reason: string };

const InitializeResult = z.object({ result: z.object({ protocolVersion: z.string() }) });

/** Runs the shim until standard input closes. */
export async function runShim(options: ShimOptions): Promise<number> {
	/**
	 * Finds or starts the daemon. Found again, it compares the daemon with the
	 * command on disk, which may have been rebuilt or upgraded since the shim
	 * started: that is the copy a daemon it starts would run, so a daemon of it,
	 * started by this shim or another, is its own and is not replaced.
	 */
	const find = async (again: boolean): Promise<Result<DaemonConnection, string>> => {
		const version = again
			? ((await versionOnDisk(options.entry)) ?? options.version)
			: options.version;
		const launched = await ensureDaemon(options.dataDirectory, version, options.entry);
		if (!launched.ok) return err(describeLaunchError(launched.error));
		const { found, notice, connection } = launched.value;
		switch (found.kind) {
			case 'own':
				break;
			case 'replaced':
				options.printError(
					describeReplacedDaemon(found.version, version, found.port === connection.port)
				);
				break;
			case 'newer':
				options.printError(describeNewerDaemon(found.version, version, options.entry));
				break;
			case 'database-newer':
				options.printError(describeDatabaseNewer(found.version, version, options.entry));
				break;
		}
		if (notice !== undefined) options.printError(notice);
		return ok(connection);
	};
	let daemon: Promise<Result<DaemonConnection, string>> = find(false);
	/**
	 * The daemon to send to: the one found, or, when it could not be found or a
	 * message failed on it, found again, once for every message that failed on
	 * the same daemon at the same time.
	 */
	const connect = (
		failedOn: DaemonConnection | undefined
	): Promise<Result<DaemonConnection, string>> => {
		daemon = daemon.then((known) =>
			known.ok && (failedOn === undefined || known.value.token !== failedOn.token)
				? known
				: find(true)
		);
		return daemon;
	};

	let protocolVersion: string | undefined;
	/** One browser window for the session, however many reports it creates. */
	const browser = new BrowserOffer(!options.noOpen);
	const transport = new StdioServerTransport();

	/**
	 * The requests on their way to the daemon, by id, each with what aborts its
	 * fetch: the agent cancelling one (`notifications/cancelled`) goes to the
	 * daemon as a message of its own, which a stateless server cannot match to
	 * the call, so the shim also drops the call's connection, and the daemon
	 * stops what it was doing for it, such as a wait for the person's requests.
	 */
	const inFlight = new Map<string | number, AbortController>();

	const post = async (
		connection: DaemonConnection,
		message: JSONRPCMessage,
		signal: AbortSignal | undefined
	): Promise<Result<readonly JSONRPCMessage[], Undelivered>> => {
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			authorization: `Bearer ${connection.mcpToken ?? connection.token}`,
			[DIRECTORY_HEADER]: encodeURIComponent(options.directory)
		};
		const ask = callsCreateReport(message) ? await browser.lend() : 'not-asked';
		const asked = browserHeader(ask);
		if (asked !== undefined) headers[OPEN_BROWSER_HEADER] = asked;
		if (protocolVersion !== undefined) headers['mcp-protocol-version'] = protocolVersion;
		let response: Response;
		try {
			response = await fetch(`${connection.origin}${MCP_PATH}`, {
				method: 'POST',
				headers,
				body: JSON.stringify(message),
				...(signal === undefined ? {} : { signal })
			});
		} catch (error) {
			browser.settle(ask, false);
			if (signal?.aborted === true)
				return err({ kind: 'cancelled', reason: 'the agent cancelled it' });
			return err({
				kind: 'retry',
				reason: `diff delver did not answer at ${connection.origin} (${error instanceof Error ? error.message : String(error)})`
			});
		}
		browser.settle(ask, response.headers.get(OPENED_HEADER) === 'yes');
		const text = await response.text().catch(() => '');
		if (signal?.aborted === true)
			return err({ kind: 'cancelled', reason: 'the agent cancelled it' });
		// The token belongs to a daemon that has stopped since, or another took the port.
		if (response.status === 403 || response.status === 421 || response.status === 503) {
			return err({
				kind: 'retry',
				reason: `diff delver at ${connection.origin} refused the message (${String(response.status)})`
			});
		}
		if (response.status === 202 || text === '') return ok([]);
		const type = response.headers.get('content-type') ?? '';
		const bodies = type.includes('text/event-stream') ? eventData(text) : [text];
		const messages: JSONRPCMessage[] = [];
		for (const body of bodies) {
			let value: unknown;
			try {
				value = JSON.parse(body);
			} catch {
				return err({
					kind: 'failed',
					reason: `diff delver answered with something that is not MCP (${String(response.status)})`
				});
			}
			for (const item of Array.isArray(value) ? value : [value]) {
				const parsed = JSONRPCMessageSchema.safeParse(item);
				if (!parsed.success) {
					return err({
						kind: 'failed',
						reason: `diff delver answered with something that is not MCP (${String(response.status)})`
					});
				}
				messages.push(parsed.data);
			}
		}
		return ok(messages);
	};

	/** Whether a message calls create_report, the one tool that may open a window. */
	const callsCreateReport = (message: JSONRPCMessage): boolean =>
		'method' in message &&
		message.method === 'tools/call' &&
		typeof message.params?.['name'] === 'string' &&
		message.params['name'] === 'create_report';

	const deliver = async (message: JSONRPCMessage): Promise<void> => {
		const cancelling = cancelledRequest(message);
		if (cancelling !== undefined) inFlight.get(cancelling)?.abort();
		const id = isJSONRPCRequest(message) ? message.id : undefined;
		const aborter = id === undefined ? undefined : new AbortController();
		if (id !== undefined && aborter !== undefined) inFlight.set(id, aborter);
		try {
			await deliverOnce(message, aborter?.signal);
		} finally {
			if (id !== undefined && inFlight.get(id) === aborter) inFlight.delete(id);
		}
	};

	const deliverOnce = async (
		message: JSONRPCMessage,
		signal: AbortSignal | undefined
	): Promise<void> => {
		let failedOn: DaemonConnection | undefined;
		let reason = '';
		for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
			const connection = await connect(failedOn);
			if (!connection.ok) {
				reason = connection.error;
				break;
			}
			const answered = await post(connection.value, message, signal);
			if (answered.ok) {
				for (const reply of answered.value) {
					const init = InitializeResult.safeParse(reply);
					if (init.success && isJSONRPCRequest(message) && message.method === 'initialize') {
						protocolVersion = init.data.result.protocolVersion;
					}
					await transport.send(reply);
				}
				return;
			}
			// A cancelled call is answered by nobody: the agent no longer waits for it.
			if (answered.error.kind === 'cancelled') return;
			reason = answered.error.reason;
			if (answered.error.kind === 'failed') break;
			failedOn = connection.value;
		}
		options.printError(`diff delver could not pass a message on to its daemon: ${reason}.`);
		if (isJSONRPCRequest(message)) {
			await transport.send({
				jsonrpc: '2.0',
				id: message.id,
				error: {
					code: -32603,
					message: `diff delver could not be reached: ${reason}. Try the call again; if it keeps failing, the person can run diff-delver in a terminal to see why.`
				}
			});
		}
	};

	const closed = new Promise<void>((resolve) => {
		transport.onclose = () => {
			resolve();
		};
	});
	const pending = new Set<Promise<void>>();
	transport.onmessage = (message) => {
		const sent = deliver(message).finally(() => {
			pending.delete(sent);
		});
		pending.add(sent);
	};
	transport.onerror = (error) => {
		options.printError(`diff delver could not read a message from the agent: ${error.message}`);
	};
	await transport.start();
	process.stdin.once('end', () => {
		void transport.close();
	});
	await closed;
	await Promise.all(pending);
	return 0;
}

/** The id of the request a `notifications/cancelled` message cancels, if it is one. */
function cancelledRequest(message: JSONRPCMessage): string | number | undefined {
	if (!('method' in message) || message.method !== 'notifications/cancelled') return undefined;
	const id = message.params?.['requestId'];
	return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

/** The data of each event of a whole server-sent event stream. */
function eventData(stream: string): readonly string[] {
	const out: string[] = [];
	for (const event of stream.split(/\r?\n\r?\n/)) {
		const data = event
			.split(/\r?\n/)
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).replace(/^ /, ''));
		if (data.length > 0) out.push(data.join('\n'));
	}
	return out;
}
