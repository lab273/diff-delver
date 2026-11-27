/**
 * `diff-delver setup`, run from the build as a person runs it, on a machine
 * of the test's own: a temporary home folder, and a `PATH` that holds only
 * stand-ins for `claude` and `codex`, which record how they were run. The
 * environment is given whole, so nothing of the machine's own agents, their
 * settings or their commands is ever read, run or changed.
 *
 * The stand-in `claude` does what Claude Code's `claude mcp add --scope user`
 * and `claude mcp remove --scope user` do to its settings file, refusing to add
 * a server whose name is taken, as the real one does.
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SKILL_MARK } from '#lib/core/agent-setup/skill-file.ts';
import { BUILT_COMMAND } from '../../../../tests/support/build.ts';
import { listDirectory } from '../../../../tests/support/directory-listing.ts';
import { tempDirectory } from '../../../../tests/support/fixture-repos.ts';

/** The one copy of the skill, which the build bundles. */
const SKILL_FILE = join(
	import.meta.dirname,
	'..',
	'..',
	'..',
	'..',
	'plugins',
	'claude-code',
	'skills',
	'diff-delver',
	'SKILL.md'
);

const STAND_IN_CLAUDE = `
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(join(__dirname, 'claude.log'), JSON.stringify(args) + '\\n');
const file = join(process.env.CLAUDE_CONFIG_DIR ?? process.env.HOME, '.claude.json');
const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
settings.mcpServers ??= {};
const [mcp, verb, scope, user, name, dashes, command, ...rest] = args;
if (mcp !== 'mcp' || scope !== '--scope' || user !== 'user') process.exit(3);
if (verb === 'add' && dashes === '--') {
	if (name in settings.mcpServers) {
		process.stderr.write('MCP server ' + name + ' already exists in user config\\n');
		process.exit(1);
	}
	settings.mcpServers[name] = { type: 'stdio', command, args: rest, env: {} };
} else if (verb === 'remove') {
	if (!(name in settings.mcpServers)) process.exit(1);
	delete settings.mcpServers[name];
} else process.exit(3);
writeFileSync(file, JSON.stringify(settings, null, 2));
`;

interface Machine {
	readonly home: string;
	readonly bin: string;
	readonly env: Record<string, string>;
}

/** A home folder and a `PATH` of stand-ins: `claude`, `codex`, both or neither. */
async function machine(agents: readonly ('claude' | 'codex')[]): Promise<Machine> {
	const root = await tempDirectory();
	const home = join(root, 'home');
	const bin = join(root, 'bin');
	await mkdir(home);
	await mkdir(bin);
	if (agents.includes('claude')) {
		await writeFile(join(bin, 'claude'), `#!${process.execPath}\n${STAND_IN_CLAUDE}`);
		await chmod(join(bin, 'claude'), 0o755);
	}
	if (agents.includes('codex')) {
		// Setup never runs Codex: the stand-in records it if it did.
		await writeFile(join(bin, 'codex'), `#!/bin/sh\necho "$@" >> "${bin}/codex.log"\n`);
		await chmod(join(bin, 'codex'), 0o755);
	}
	return { home, bin, env: { HOME: home, PATH: bin } };
}

interface Ran {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

function setup(on: Machine, args: readonly string[] = []): Promise<Ran> {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[BUILT_COMMAND, 'setup', ...args],
			{ cwd: on.home, env: on.env },
			(error, stdout, stderr) => {
				const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
				resolve({ code, stdout, stderr });
			}
		);
	});
}

async function text(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, 'utf8');
	} catch {
		return undefined;
	}
}

async function claudeCalls(on: Machine): Promise<unknown[]> {
	const log = (await text(join(on.bin, 'claude.log'))) ?? '';
	return log
		.split('\n')
		.filter((line) => line !== '')
		.map((line): unknown => JSON.parse(line));
}

const SettingsSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()) });

/** The server Claude Code's settings have for the person under diff delver's name. */
async function claudeServer(on: Machine): Promise<unknown> {
	const settings = await text(join(on.home, '.claude.json'));
	if (settings === undefined) return undefined;
	return SettingsSchema.parse(JSON.parse(settings)).mcpServers['diff-delver'];
}

/** What this build registers: this Node, this clone's command, and the data folder named. */
function ours(data: string): string[] {
	return [process.execPath, BUILT_COMMAND, 'mcp', '--data-directory', data];
}

describe('diff-delver setup', () => {
	it('sets up both agents, does nothing the second time, and undo gives back what was there', async () => {
		const on = await machine(['claude', 'codex']);
		const data = join(on.home, 'data');
		const codexConfig = join(on.home, '.codex', 'config.toml');
		await mkdir(join(on.home, '.codex'));
		const before = '# my Codex\nmodel = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n';
		await writeFile(codexConfig, before);

		const first = await setup(on, ['--data-directory', data]);
		expect(first.stderr).toBe('');
		expect(first.code).toBe(0);
		expect(first.stdout).toContain(
			'Claude Code:\n  - Added the MCP server diff-delver, in ~/.claude.json'
		);
		expect(first.stdout).toContain('Added the skill, ~/.claude/skills/diff-delver/SKILL.md.');
		expect(first.stdout).toContain(
			'Codex:\n  - Added the MCP server diff-delver, in ~/.codex/config.toml'
		);
		expect(first.stdout).toContain('Added the skill, ~/.codex/skills/diff-delver/SKILL.md.');
		expect(first.stdout).toContain('setup --data-directory ~/data --undo');
		expect(await claudeCalls(on)).toEqual([
			['mcp', 'add', '--scope', 'user', 'diff-delver', '--', ...ours(data)]
		]);
		expect(await claudeServer(on)).toMatchObject({
			command: process.execPath,
			args: ours(data).slice(1)
		});
		const config = await text(codexConfig);
		expect(config?.startsWith(before)).toBe(true);
		expect(config).toContain(
			`[mcp_servers.diff-delver]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${ours(
				data
			)
				.slice(1)
				.map((arg) => JSON.stringify(arg))
				.join(', ')}]\n`
		);
		const skill = await readFile(SKILL_FILE, 'utf8');
		for (const folder of ['.claude', '.codex']) {
			const saved = await text(join(on.home, folder, 'skills', 'diff-delver', 'SKILL.md'));
			expect(saved).toContain(SKILL_MARK);
			expect(saved?.startsWith('---\nname: diff-delver\n')).toBe(true);
			expect(saved?.replace(`\n${SKILL_MARK}\n`, '')).toBe(skill);
		}

		const listing = await listDirectory(on.home);
		const again = await setup(on, ['--data-directory', data]);
		expect(again.code).toBe(0);
		expect(again.stdout).toContain(
			'Claude Code:\n  - The MCP server diff-delver was already set up the same way. Nothing changed.'
		);
		expect(again.stdout).not.toContain('start it again');
		expect(await claudeCalls(on)).toHaveLength(1);
		expect(await listDirectory(on.home)).toEqual(listing);

		const undone = await setup(on, ['--data-directory', data, '--undo']);
		expect(undone.code).toBe(0);
		expect(undone.stdout).toContain('Removed the MCP server diff-delver, from ~/.claude.json.');
		expect(undone.stdout).toContain('Removed the skill, ~/.codex/skills/diff-delver/SKILL.md.');
		expect((await claudeCalls(on)).at(-1)).toEqual([
			'mcp',
			'remove',
			'--scope',
			'user',
			'diff-delver'
		]);
		expect(await claudeServer(on)).toBeUndefined();
		expect(await text(codexConfig)).toBe(before);
		expect(
			await text(join(on.home, '.claude', 'skills', 'diff-delver', 'SKILL.md'))
		).toBeUndefined();
		expect(await readdir(join(on.home, '.codex', 'skills'))).toEqual([]);
		expect(await text(join(on.bin, 'codex.log'))).toBeUndefined();
	});

	it('replaces an entry that runs something else, saying what it ran, and leaves a skill saved by hand', async () => {
		const on = await machine(['claude', 'codex']);
		await writeFile(
			join(on.home, '.claude.json'),
			JSON.stringify({
				mcpServers: {
					'diff-delver': { type: 'stdio', command: 'node', args: ['/old/diff-delver.js', 'mcp'] }
				}
			})
		);
		const codexHome = join(on.home, 'elsewhere');
		await mkdir(codexHome);
		const old =
			'[mcp_servers.diff-delver]\ncommand = "node"\nargs = ["/old/diff-delver.js", "mcp"]';
		const config = `model = "o3"\n\n${old}\n\n# next\n[profiles.fast]\nmodel = "mini"\n`;
		await writeFile(join(codexHome, 'config.toml'), config);
		await mkdir(join(on.home, '.claude', 'skills', 'diff-delver'), { recursive: true });
		await writeFile(
			join(on.home, '.claude', 'skills', 'diff-delver', 'SKILL.md'),
			'# My own notes\n'
		);

		const ran = await setup({ ...on, env: { ...on.env, CODEX_HOME: codexHome } });
		expect(ran.code).toBe(0);
		expect(ran.stdout).toContain(
			'which ran something else. It was:\n      node /old/diff-delver.js mcp'
		);
		expect(ran.stdout).toContain(
			`It was:\n${old
				.split('\n')
				.map((line) => `      ${line}`)
				.join('\n')}`
		);
		expect(ran.stdout).toContain(
			'~/.claude/skills/diff-delver/SKILL.md is there already, with other words'
		);
		expect(ran.stdout).toContain('Added the skill, ~/elsewhere/skills/diff-delver/SKILL.md.');
		expect(await claudeCalls(on)).toEqual([
			['mcp', 'remove', '--scope', 'user', 'diff-delver'],
			['mcp', 'add', '--scope', 'user', 'diff-delver', '--', process.execPath, BUILT_COMMAND, 'mcp']
		]);
		const written = await text(join(codexHome, 'config.toml'));
		expect(written).toBe(
			config.replace(
				old,
				`[mcp_servers.diff-delver]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(BUILT_COMMAND)}, "mcp"]`
			)
		);
		expect(await text(join(on.home, '.claude', 'skills', 'diff-delver', 'SKILL.md'))).toBe(
			'# My own notes\n'
		);

		const undone = await setup({ ...on, env: { ...on.env, CODEX_HOME: codexHome } }, ['--undo']);
		expect(undone.stdout).toContain(
			'~/.claude/skills/diff-delver/SKILL.md was not put there by setup, so it is left as it is.'
		);
		expect(await text(join(on.home, '.claude', 'skills', 'diff-delver', 'SKILL.md'))).toBe(
			'# My own notes\n'
		);
		expect(await text(join(codexHome, 'config.toml'))).toBe(
			`model = "o3"\n\n# next\n[profiles.fast]\nmodel = "mini"\n`
		);
	});

	it('says when it finds no agent, with the command for another, and writes nothing', async () => {
		const on = await machine([]);
		const ran = await setup(on);
		expect(ran.code).toBe(0);
		expect(ran.stdout).toContain('diff delver found no coding agent to set up on this machine');
		expect(ran.stdout).toContain(`${process.execPath} ${BUILT_COMMAND} mcp`);
		expect(await readdir(on.home)).toEqual([]);
	});

	it('sets up Codex found by its folder alone, and says how to add Claude Code by hand', async () => {
		const on = await machine([]);
		await mkdir(join(on.home, '.codex'));
		const ran = await setup(on);
		expect(ran.code).toBe(0);
		expect(ran.stdout).toContain('Claude Code: not found, since there is no claude command.');
		expect(ran.stdout).toContain(`claude mcp add --scope user diff-delver -- ${process.execPath}`);
		expect(ran.stdout).toContain('Codex:\n  - Added the MCP server diff-delver');
	});
});
