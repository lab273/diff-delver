/**
 * How a coding agent is given this diff delver as an MCP server: the command
 * that runs `diff-delver mcp` for the copy that is running and its data folder,
 * so the agent's server reaches the daemon the person's page is served by and
 * not another one.
 *
 * - A release is run as the README runs it, from the newest release's address.
 * - A build that is no release (a clone's, its version marked `-dev`) is run
 *   by the file that started its daemon, `node <clone>/bin/diff-delver.js`:
 *   the release's command would start a different copy, which would replace
 *   the daemon the page is on.
 * - A data folder that is not this machine's default is named with
 *   `--data-directory`, or the agent's server would start a second daemon on
 *   the default folder and never see the person's Delves.
 *
 * Three forms, each grounded in what the project itself runs: Claude Code's
 * `claude mcp add` (the README), Codex's `config.toml` entry (the agent trials,
 * `tests/agent-trials/agent-cli.ts`), and the plain command for any other
 * agent's MCP server entry.
 */
import type { AbsolutePath } from '../absolute-path.tiny.ts';
import type { CodeVersion } from '../code-version.tiny.ts';
import { releaseOfCodeVersion } from '../release-version.tiny.ts';
import { shellCommand } from './shell-words.ts';
import { textToCopy, type TextToCopy } from './text-to-copy.tiny.ts';

/** Where the newest release's package is fetched from (README, "Use it"). */
export const RELEASE_ADDRESS =
	'https://github.com/lab273/diff-delver/releases/latest/download/diff-delver.tgz';

/** The name an agent knows the server by. */
export const SERVER_NAME = 'diff-delver';

/** Which copy of diff delver is running, as far as running it again goes. */
export type RunningCopy =
	| { readonly kind: 'release' }
	/** A build that is no release, started by the file `entry`. */
	| { readonly kind: 'build'; readonly entry: AbsolutePath };

/**
 * The copy a daemon is, from its version and the file its command was run by.
 * A build that cannot say which file that was (only a daemon a test starts in
 * its own process) is given the release's command, the only one there is.
 */
export function copyOf(version: CodeVersion, entry: AbsolutePath | undefined): RunningCopy {
	if (releaseOfCodeVersion(version) !== undefined || entry === undefined) {
		return { kind: 'release' };
	}
	return { kind: 'build', entry };
}

export interface AgentServerSetup {
	readonly copy: RunningCopy;
	/** The daemon's data folder when it is not this machine's default, and undefined when it is. */
	readonly dataDirectory: AbsolutePath | undefined;
	/** The person's home folder, which shortens what is pasted into a terminal. */
	readonly home: AbsolutePath | undefined;
}

/** The data folder to name in the command: none when it is the machine's default. */
export function dataDirectoryToName(
	dataDirectory: AbsolutePath,
	machineDefault: AbsolutePath | undefined
): AbsolutePath | undefined {
	return dataDirectory === machineDefault ? undefined : dataDirectory;
}

/** The program an MCP server entry runs, and its arguments, each exact. */
export function serverWords(setup: AgentServerSetup): readonly [string, ...string[]] {
	const data = setup.dataDirectory === undefined ? [] : ['--data-directory', setup.dataDirectory];
	switch (setup.copy.kind) {
		case 'release':
			return ['npx', '--yes', RELEASE_ADDRESS, 'mcp', ...data];
		case 'build':
			return ['node', setup.copy.entry, 'mcp', ...data];
	}
}

/** For Claude Code: the command that adds the server, for a terminal. */
export function claudeCodeCommand(setup: AgentServerSetup): TextToCopy {
	return textToCopy(
		shellCommand(['claude', 'mcp', 'add', SERVER_NAME, '--', ...serverWords(setup)], setup.home)
	);
}

/** A TOML basic string, which escapes as JSON does for any text a path can hold. */
function toml(value: string): string {
	return JSON.stringify(value).replaceAll('\u007f', '\\u007F');
}

/** For Codex: the server's entry in its `config.toml`. Nothing there is read by a shell, so paths are whole. */
export function codexConfigEntry(setup: AgentServerSetup): TextToCopy {
	const [command, ...args] = serverWords(setup);
	return textToCopy(
		[
			`[mcp_servers.${SERVER_NAME}]`,
			`command = ${toml(command)}`,
			`args = [${args.map(toml).join(', ')}]`
		].join('\n')
	);
}

/**
 * For any other agent: the command its MCP server entry runs, quoted as a
 * shell would need it and with every path whole, since most settings files are
 * not read by a shell.
 */
export function plainServerCommand(setup: AgentServerSetup): TextToCopy {
	return textToCopy(shellCommand(serverWords(setup), undefined));
}
