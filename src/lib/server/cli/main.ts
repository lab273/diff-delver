/**
 * The `diff-delver` command (DESIGN 3). What it prints is for a person: one or
 * two plain lines saying what it did and where, and errors that say what
 * happened and what to do next, never a stack trace. It never asks a question.
 *
 * `bin/diff-delver.js` runs this from the build (`vite.cli.config.ts`).
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ApiClient } from '#lib/api/client.ts';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import {
	DATA_DIRECTORY_VARIABLE,
	describeCommandLineError,
	HELP_TEXT,
	parseCommandLine,
	type Invocation
} from '#lib/core/cli/command-line.ts';
import { describeNoDataDirectory } from '#lib/core/data-directory.ts';
import { preferredPortFor } from '#lib/core/daemon/stable-port.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { loadAppHandler } from '../daemon/app-handler.ts';
import { describeDaemonStartError, entryAddress, startDaemon } from '../daemon/daemon.ts';
import {
	describeLaunchError,
	ensureDaemon,
	stopDaemon,
	type ReadySignal
} from '../daemon/launcher.ts';
import { machineDataDirectory } from '../store/index.ts';
import { randomIds, systemClock } from '../system.ts';
import { codeVersion } from '../version.ts';
import {
	describeDatabaseNewer,
	describeNewerDaemon,
	describeReplacedDaemon
} from '#lib/core/cli/replaced-daemon.ts';
import { runShim } from './mcp-shim.ts';
import { openBrowser } from './open-browser.ts';
import {
	chooseOutcome,
	describerFor,
	openOutcome,
	startOutcome,
	type CommandOutcome,
	type DescribeApiError
} from './outcome.ts';

export interface Terminal {
	readonly print: (line: string) => void;
	readonly printError: (line: string) => void;
}

const terminal: Terminal = {
	print: (line) => {
		process.stdout.write(`${line}\n`);
	},
	printError: (line) => {
		process.stderr.write(`${line}\n`);
	}
};

function dataDirectoryOf(invocation: Invocation, cwd: string): Result<AbsolutePath, string> {
	const given = invocation.dataDirectory ?? process.env[DATA_DIRECTORY_VARIABLE];
	if (given !== undefined && given !== '') {
		const path = parseAbsolutePath(resolve(cwd, given));
		return path.ok
			? ok(path.value)
			: err(`${given} cannot be used as a data folder. Give the path of a folder instead.`);
	}
	const machine = machineDataDirectory();
	return machine.ok ? machine : err(describeNoDataDirectory(machine.error));
}

/** Tells the command that started this daemon in the background how starting went. */
function signalParent(signal: ReadySignal): void {
	if (process.send === undefined) return;
	process.send(signal, undefined, {}, () => {
		if (process.connected) process.disconnect?.();
	});
}

/** A path of the machine's, when it is one a daemon can use. */
function absolute(path: string): AbsolutePath | undefined {
	if (path === '') return undefined;
	const parsed = parseAbsolutePath(resolve(path));
	return parsed.ok ? parsed.value : undefined;
}

function homeFolder(): AbsolutePath | undefined {
	try {
		return absolute(homedir());
	} catch {
		return undefined;
	}
}

async function serve(
	dataDirectory: AbsolutePath,
	background: boolean,
	entry: string
): Promise<number> {
	const app = await loadAppHandler();
	const machine = machineDataDirectory();
	const started = await startDaemon({
		dataDirectory,
		clock: systemClock,
		ids: randomIds,
		version: codeVersion(),
		app,
		openBrowser,
		preferredPort: preferredPortFor(dataDirectory, machine.ok ? machine.value : undefined),
		// `entry` is the file this daemon was run by, so `node <entry> mcp` is this same copy.
		machine: {
			entry: absolute(entry),
			node: absolute(process.execPath),
			defaultDataDirectory: machine.ok ? machine.value : undefined,
			home: homeFolder()
		}
	});
	if (!started.ok) {
		// Started in the background by a command that raced another: the daemon that
		// won serves it, so starting succeeded.
		if (background && started.error.kind === 'AlreadyRunning') {
			signalParent({ kind: 'ready' });
			return 0;
		}
		const message = describeDaemonStartError(started.error);
		if (background) signalParent({ kind: 'failed', message });
		terminal.printError(message);
		return 1;
	}
	const daemon = started.value;
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
		process.once(signal, () => {
			void daemon.stop();
		});
	}
	if (background) {
		console.log(`diff delver started at ${daemon.origin}, serving ${dataDirectory}.`);
		signalParent(
			daemon.portNotice === undefined
				? { kind: 'ready' }
				: { kind: 'ready', notice: daemon.portNotice }
		);
	} else {
		terminal.print(
			`diff delver is running. Open this in your browser: ${entryAddress(daemon.origin, '/', daemon.entryCode())}`
		);
		terminal.print(WORKS_ONCE);
		terminal.print('Press Ctrl+C to stop it.');
	}
	await daemon.stopped;
	if (!background) terminal.print('diff delver has stopped.');
	return 0;
}

/** What to do when the browser was asked to open the page and none appeared. */
const NO_BROWSER =
	'If no browser window appeared, run diff-delver again with --no-open, and open the address it prints yourself.';

/** What an address with an entry code is good for, said after it. */
const WORKS_ONCE = 'The address works once; run diff-delver again for a new one.';

async function show(
	client: ApiClient,
	origin: string,
	outcome: CommandOutcome,
	noOpen: boolean,
	describe: DescribeApiError
): Promise<number> {
	for (const line of outcome.lines)
		(outcome.exitCode === 0 ? terminal.print : terminal.printError)(line);
	if (outcome.page === undefined) return outcome.exitCode;
	const code = await client.entryCode();
	if (!code.ok) {
		terminal.printError(describe(code.error));
		return 1;
	}
	const address = entryAddress(origin, outcome.page, code.value.code);
	if (!noOpen && (await openBrowser(address))) {
		terminal.print(`Opened in your browser: ${origin}${outcome.page}`);
		terminal.print(NO_BROWSER);
	} else {
		terminal.print(`Open this in your browser: ${address}`);
		terminal.print(WORKS_ONCE);
	}
	return outcome.exitCode;
}

export async function main(args: readonly string[], cwd: string, entry: string): Promise<number> {
	const parsed = parseCommandLine(args);
	if (!parsed.ok) {
		terminal.printError(describeCommandLineError(parsed.error));
		return 2;
	}
	const invocation = parsed.value;
	const { command } = invocation;
	switch (command.kind) {
		case 'help':
			terminal.print(HELP_TEXT);
			return 0;
		case 'version':
			terminal.print(`diff-delver ${codeVersion()}`);
			return 0;
		case 'serve':
		case 'stop':
		case 'mcp':
		case 'start':
		case 'open':
		case 'choose':
			break;
	}
	const dataDirectory = dataDirectoryOf(invocation, cwd);
	if (!dataDirectory.ok) {
		terminal.printError(dataDirectory.error);
		return 1;
	}
	switch (command.kind) {
		case 'serve':
			return serve(dataDirectory.value, process.send !== undefined, entry);
		case 'mcp': {
			const directory = parseAbsolutePath(resolve(cwd));
			if (!directory.ok) {
				terminal.printError(
					'diff delver cannot tell which folder it was started in. Start it from inside your repository.'
				);
				return 1;
			}
			return runShim({
				dataDirectory: dataDirectory.value,
				directory: directory.value,
				noOpen: invocation.noOpen,
				version: codeVersion(),
				entry,
				printError: terminal.printError
			});
		}
		case 'stop': {
			const stopped = await stopDaemon(dataDirectory.value);
			switch (stopped.kind) {
				case 'stopped':
					terminal.print('diff delver has stopped.');
					return 0;
				case 'not-running':
					terminal.print('diff delver is not running.');
					return 0;
				case 'stale':
					terminal.print(
						'diff delver was not running. It had left behind a note saying it was, from a run that ended without tidying up; the note is removed and nothing else was touched.'
					);
					return 0;
				case 'would-not-stop':
					terminal.printError(
						`diff delver did not stop when asked. End its process, number ${String(stopped.pid)}, then try again.`
					);
					return 1;
			}
			break;
		}
		case 'start':
		case 'open':
		case 'choose': {
			const directory = parseAbsolutePath(resolve(cwd));
			if (!directory.ok) {
				terminal.printError(
					'diff delver cannot tell which folder it was run in. Run it again from inside your repository.'
				);
				return 1;
			}
			const launched = await ensureDaemon(dataDirectory.value, codeVersion(), entry);
			if (!launched.ok) {
				terminal.printError(describeLaunchError(launched.error));
				return 1;
			}
			const { connection, found, notice } = launched.value;
			switch (found.kind) {
				case 'own':
					break;
				case 'replaced':
					terminal.print(
						describeReplacedDaemon(found.version, codeVersion(), found.port === connection.port)
					);
					break;
				case 'newer':
					terminal.print(describeNewerDaemon(found.version, codeVersion(), entry));
					break;
				case 'database-newer':
					terminal.print(describeDatabaseNewer(found.version, codeVersion(), entry));
					break;
			}
			if (notice !== undefined) terminal.print(notice);
			const describe = describerFor(found, codeVersion(), entry);
			const client = new ApiClient({ fetch, base: connection.origin, token: connection.token });
			const outcome =
				command.kind === 'start'
					? await startOutcome(client, directory.value, describe)
					: command.kind === 'choose'
						? await chooseOutcome(client, directory.value, describe)
						: await openOutcome(client, directory.value, command.source, describe);
			return show(client, connection.origin, outcome, invocation.noOpen, describe);
		}
	}
}
