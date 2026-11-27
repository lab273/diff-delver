/**
 * `diff-delver setup` (DESIGN 3): connects the coding agents it finds on this
 * machine to this copy of diff delver, its MCP server and its skill, and
 * `--undo` takes out what it put in. What to write and the words are core's
 * (`#lib/core/agent-setup/`); this finds the agents and changes their files.
 *
 * - Claude Code, found by its `claude` command: the server is added for the
 *   person (`--scope user`) by that command, never by editing its settings,
 *   which a running Claude Code writes over. What is there now is read from
 *   its settings file (`~/.claude.json`, or `.claude.json` in
 *   `CLAUDE_CONFIG_DIR`), only to compare. The skill goes in its skills folder.
 * - Codex, found by its `codex` command or its folder (`CODEX_HOME`, else
 *   `~/.codex`): the server's table in `config.toml`, changed in place with
 *   every other byte kept (`codex-config.ts`), and the skill in its skills folder.
 *
 * The skill is the build's own copy of `plugins/claude-code/skills/diff-delver/SKILL.md`.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
	access,
	chmod,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	stat,
	writeFile
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import {
	SERVER_NAME,
	serverWords,
	type AgentServerSetup
} from '#lib/core/agent-setup/agent-server.ts';
import {
	addCodexEntry,
	removeCodexEntry,
	sameCommand,
	type ServerCommand
} from '#lib/core/agent-setup/codex-config.ts';
import { codexConfigEntry } from '#lib/core/agent-setup/agent-server.ts';
import { shellCommand } from '#lib/core/agent-setup/shell-words.ts';
import { installedSkill, isSetupSkill, skillChange } from '#lib/core/agent-setup/skill-file.ts';
import type {
	ServerSetUp,
	ServerUndone,
	SetupResult,
	SkillSetUp,
	SkillUndone,
	UndoResult
} from '#lib/core/agent-setup/setup-words.ts';
import SKILL from '../../../../plugins/claude-code/skills/diff-delver/SKILL.md?raw';

/** How long an agent's own command may take to add or remove the server. */
const AGENT_COMMAND_MS = 60_000;

type Environment = Readonly<Record<string, string | undefined>>;

/** Where one machine keeps each agent's settings, from its environment. */
interface Places {
	readonly claude: AbsolutePath | undefined;
	readonly claudeSettings: AbsolutePath;
	readonly claudeSkill: AbsolutePath;
	readonly codex: AbsolutePath | undefined;
	readonly codexHome: AbsolutePath;
	readonly codexFound: boolean;
}

function path(text: string): AbsolutePath {
	const parsed = parseAbsolutePath(text);
	// Every path here is joined onto the home folder, which is absolute.
	if (!parsed.ok) throw new Error(`not an absolute path: ${text}`);
	return parsed.value;
}

/** The file `name` on `PATH` that may be run, as a shell would find it. */
async function onPath(name: string, env: Environment): Promise<AbsolutePath | undefined> {
	for (const folder of (env['PATH'] ?? '').split(':')) {
		if (!folder.startsWith('/')) continue;
		const file = join(folder, name);
		try {
			await access(file, constants.X_OK);
			if ((await stat(file)).isFile()) return path(file);
		} catch {
			// Not here.
		}
	}
	return undefined;
}

async function isFolder(where: string): Promise<boolean> {
	try {
		return (await stat(where)).isDirectory();
	} catch {
		return false;
	}
}

async function placesOf(env: Environment, home: AbsolutePath): Promise<Places> {
	const claudeFolder = env['CLAUDE_CONFIG_DIR'];
	const claudeHome =
		claudeFolder !== undefined && claudeFolder.startsWith('/') ? claudeFolder : undefined;
	const codexFolder = env['CODEX_HOME'];
	const codexHome = path(
		codexFolder !== undefined && codexFolder.startsWith('/') ? codexFolder : join(home, '.codex')
	);
	const codex = await onPath('codex', env);
	return {
		claude: await onPath('claude', env),
		claudeSettings: path(join(claudeHome ?? home, '.claude.json')),
		claudeSkill: path(join(claudeHome ?? join(home, '.claude'), 'skills', SERVER_NAME, 'SKILL.md')),
		codex,
		codexHome,
		codexFound: codex !== undefined || (await isFolder(codexHome))
	};
}

function ours(setup: AgentServerSetup): ServerCommand {
	const [command, ...args] = serverWords(setup);
	return { command, args };
}

/** What the system's error codes that a person can act on mean. */
const PROBLEMS: Readonly<Record<string, string>> = {
	EACCES: 'diff delver may not write there. Check who owns the folder, then try again.',
	EPERM: 'diff delver may not write there. Check who owns the folder, then try again.',
	ENOSPC: 'the disk is full. Free some space, then try again.',
	EROFS: 'that folder cannot be written to.'
};

function problem(error: unknown): string {
	if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
		const known = PROBLEMS[error.code];
		if (known !== undefined) return known;
	}
	return error instanceof Error ? error.message : String(error);
}

async function readIfThere(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, 'utf8');
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
		throw error;
	}
}

/**
 * Writes `text` over `file` all at once, through a link to it, keeping its
 * mode: written beside it and moved into place, so an agent never reads half of it.
 */
async function replaceFile(file: string, text: string): Promise<void> {
	let target = file;
	let mode: number | undefined;
	try {
		target = await realpath(file);
		mode = (await stat(target)).mode & 0o7777;
	} catch {
		// A new file.
	}
	await mkdir(dirname(target), { recursive: true });
	const temporary = `${target}.diff-delver-${String(process.pid)}`;
	try {
		await writeFile(temporary, text, { mode: mode ?? 0o600 });
		if (mode !== undefined) await chmod(temporary, mode);
		await rename(temporary, target);
	} finally {
		await rm(temporary, { force: true });
	}
}

/** What runs `claude` itself says when it fails, or how it failed. */
function runAgent(program: AbsolutePath, args: readonly string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			program,
			args,
			{ timeout: AGENT_COMMAND_MS, windowsHide: true },
			(error, _stdout, stderr) => {
				if (error === null) {
					resolve(undefined);
					return;
				}
				const said = stderr.trim();
				resolve(
					`${program} ${args.slice(0, 3).join(' ')} failed${said === '' ? ` (${error.message})` : `: ${said}`}`
				);
			}
		).stdin?.end();
	});
}

const ClaudeEntrySchema = z
	.object({
		type: z.string().optional(),
		command: z.string(),
		args: z.array(z.string()).optional()
	})
	.loose();
const ClaudeSettingsSchema = z
	.object({ mcpServers: z.record(z.string(), z.unknown()).optional() })
	.loose();

type ClaudeEntry =
	| { readonly kind: 'none' }
	| { readonly kind: 'command'; readonly runs: ServerCommand }
	| { readonly kind: 'other'; readonly shown: string };

/** The server Claude Code has for the person under our name, read from its settings. */
async function claudeEntry(settings: AbsolutePath): Promise<ClaudeEntry> {
	let text: string | undefined;
	try {
		text = await readIfThere(settings);
	} catch {
		return { kind: 'none' };
	}
	if (text === undefined) return { kind: 'none' };
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		// Claude Code's own command says what is wrong with its file.
		return { kind: 'none' };
	}
	const parsed = ClaudeSettingsSchema.safeParse(json);
	const entry = parsed.success ? parsed.data.mcpServers?.[SERVER_NAME] : undefined;
	if (entry === undefined) return { kind: 'none' };
	const command = ClaudeEntrySchema.safeParse(entry);
	if (command.success && (command.data.type === undefined || command.data.type === 'stdio')) {
		return {
			kind: 'command',
			runs: { command: command.data.command, args: command.data.args ?? [] }
		};
	}
	return { kind: 'other', shown: JSON.stringify(entry) };
}

function shownCommand(runs: ServerCommand, home: AbsolutePath | undefined): string {
	return shellCommand([runs.command, ...runs.args], home);
}

const ADD = (setup: AgentServerSetup): string[] => [
	'mcp',
	'add',
	'--scope',
	'user',
	SERVER_NAME,
	'--',
	...serverWords(setup)
];
const REMOVE = ['mcp', 'remove', '--scope', 'user', SERVER_NAME];

async function claudeServer(
	claude: AbsolutePath,
	settings: AbsolutePath,
	setup: AgentServerSetup
): Promise<ServerSetUp> {
	const now = await claudeEntry(settings);
	if (now.kind === 'command' && sameCommand(now.runs, ours(setup))) return { kind: 'unchanged' };
	if (now.kind !== 'none') {
		const removed = await runAgent(claude, REMOVE);
		if (removed !== undefined) return { kind: 'failed', detail: removed };
	}
	const added = await runAgent(claude, ADD(setup));
	if (added !== undefined) return { kind: 'failed', detail: added };
	switch (now.kind) {
		case 'none':
			return { kind: 'added' };
		case 'command':
			return { kind: 'replaced', before: shownCommand(now.runs, setup.home) };
		case 'other':
			return { kind: 'replaced', before: now.shown };
	}
}

async function claudeServerUndo(
	claude: AbsolutePath,
	settings: AbsolutePath,
	setup: AgentServerSetup
): Promise<ServerUndone> {
	const now = await claudeEntry(settings);
	switch (now.kind) {
		case 'none':
			return { kind: 'none' };
		case 'other':
			return { kind: 'other', before: now.shown };
		case 'command': {
			if (!sameCommand(now.runs, ours(setup))) {
				return { kind: 'other', before: shownCommand(now.runs, setup.home) };
			}
			const removed = await runAgent(claude, REMOVE);
			return removed === undefined ? { kind: 'removed' } : { kind: 'failed', detail: removed };
		}
	}
}

async function codexServer(codexHome: AbsolutePath, setup: AgentServerSetup): Promise<ServerSetUp> {
	const file = join(codexHome, 'config.toml');
	try {
		const change = addCodexEntry(
			(await readIfThere(file)) ?? '',
			codexConfigEntry(setup),
			ours(setup)
		);
		switch (change.kind) {
			case 'unchanged':
			case 'elsewhere':
				return change;
			case 'added':
				await replaceFile(file, change.text);
				return { kind: 'added' };
			case 'replaced':
				await replaceFile(file, change.text);
				return { kind: 'replaced', before: change.before };
		}
	} catch (error) {
		return { kind: 'failed', detail: problem(error) };
	}
}

async function codexServerUndo(
	codexHome: AbsolutePath,
	setup: AgentServerSetup
): Promise<ServerUndone> {
	const file = join(codexHome, 'config.toml');
	try {
		const text = await readIfThere(file);
		if (text === undefined) return { kind: 'none' };
		const removal = removeCodexEntry(text, ours(setup));
		switch (removal.kind) {
			case 'none':
			case 'elsewhere':
				return removal;
			case 'other':
				return { kind: 'other', before: removal.before };
			case 'removed':
				await replaceFile(file, removal.text);
				return { kind: 'removed' };
		}
	} catch (error) {
		return { kind: 'failed', detail: problem(error) };
	}
}

async function saveSkill(file: AbsolutePath): Promise<SkillSetUp> {
	try {
		const change = skillChange(await readIfThere(file), SKILL);
		switch (change) {
			case 'unchanged':
			case 'theirs':
				return { kind: change };
			case 'add':
			case 'update':
				await replaceFile(file, installedSkill(SKILL));
				return { kind: change === 'add' ? 'added' : 'updated' };
		}
	} catch (error) {
		return { kind: 'failed', detail: problem(error) };
	}
}

/** Takes away the skill when setup put it there, and its folder once that is empty. */
async function removeSkill(file: AbsolutePath): Promise<SkillUndone> {
	try {
		const text = await readIfThere(file);
		if (text === undefined) return { kind: 'none' };
		if (!isSetupSkill(text)) return { kind: 'theirs' };
		await rm(file);
		await rmdir(dirname(file)).catch(() => undefined);
		return { kind: 'removed' };
	} catch (error) {
		return { kind: 'failed', detail: problem(error) };
	}
}

/** Sets up every agent found, Claude Code then Codex, each whatever became of the other. */
export async function setUpAgents(
	setup: AgentServerSetup,
	env: Environment,
	home: AbsolutePath
): Promise<SetupResult[]> {
	const places = await placesOf(env, home);
	const codexSkill = path(join(places.codexHome, 'skills', SERVER_NAME, 'SKILL.md'));
	return [
		places.claude === undefined
			? { agent: 'claudeCode', found: false }
			: {
					agent: 'claudeCode',
					found: true,
					configFile: places.claudeSettings,
					skillFile: places.claudeSkill,
					server: await claudeServer(places.claude, places.claudeSettings, setup),
					skill: await saveSkill(places.claudeSkill)
				},
		!places.codexFound
			? { agent: 'codex', found: false }
			: {
					agent: 'codex',
					found: true,
					configFile: path(join(places.codexHome, 'config.toml')),
					skillFile: codexSkill,
					server: await codexServer(places.codexHome, setup),
					skill: await saveSkill(codexSkill)
				}
	];
}

/** Takes out what setting up this copy put in, for every agent found. */
export async function undoAgents(
	setup: AgentServerSetup,
	env: Environment,
	home: AbsolutePath
): Promise<UndoResult[]> {
	const places = await placesOf(env, home);
	const codexSkill = path(join(places.codexHome, 'skills', SERVER_NAME, 'SKILL.md'));
	return [
		places.claude === undefined
			? { agent: 'claudeCode', found: false }
			: {
					agent: 'claudeCode',
					found: true,
					configFile: places.claudeSettings,
					skillFile: places.claudeSkill,
					server: await claudeServerUndo(places.claude, places.claudeSettings, setup),
					skill: await removeSkill(places.claudeSkill)
				},
		!places.codexFound
			? { agent: 'codex', found: false }
			: {
					agent: 'codex',
					found: true,
					configFile: path(join(places.codexHome, 'config.toml')),
					skillFile: codexSkill,
					server: await codexServerUndo(places.codexHome, setup),
					skill: await removeSkill(codexSkill)
				}
	];
}
