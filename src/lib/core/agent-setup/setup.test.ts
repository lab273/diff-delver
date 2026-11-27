import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseAbsolutePath, type AbsolutePath } from '../absolute-path.tiny.ts';
import { parseCommandLine } from '../cli/command-line.ts';
import {
	codexConfigEntry,
	serverWords,
	setupCommand,
	type AgentServerSetup
} from './agent-server.ts';
import {
	addCodexEntry,
	findCodexEntry,
	removeCodexEntry,
	type ServerCommand
} from './codex-config.ts';
import { installedSkill, isSetupSkill, SKILL_MARK, skillChange } from './skill-file.ts';
import { anyFailed, describeSetup, describeUndo, type SetupResult } from './setup-words.ts';

function path(text: string): AbsolutePath {
	const parsed = parseAbsolutePath(text);
	if (!parsed.ok) throw new Error(`not a path: ${text}`);
	return parsed.value;
}

const release: AgentServerSetup = {
	copy: { kind: 'release' },
	dataDirectory: undefined,
	home: path('/home/r')
};
const build: AgentServerSetup = {
	copy: {
		kind: 'build',
		entry: path('/home/r/src/diff-delver/bin/diff-delver.js'),
		node: path('/opt/node/bin/node')
	},
	dataDirectory: path('/home/r/data'),
	home: path('/home/r')
};

function runs(setup: AgentServerSetup): ServerCommand {
	const [command, ...args] = serverWords(setup);
	return { command, args };
}

const ENTRY = codexConfigEntry(release);
const RUNS = runs(release);

describe("Codex's config.toml", () => {
	it('adds the table to an empty file, and after a blank line to one with something in it', () => {
		expect(addCodexEntry('', ENTRY, RUNS)).toEqual({ kind: 'added', text: `${ENTRY}\n` });
		expect(addCodexEntry('model = "o3"', ENTRY, RUNS)).toEqual({
			kind: 'added',
			text: `model = "o3"\n\n${ENTRY}\n`
		});
		expect(addCodexEntry('model = "o3"\n', ENTRY, RUNS)).toEqual({
			kind: 'added',
			text: `model = "o3"\n\n${ENTRY}\n`
		});
	});

	it('reads what a table runs, in any of the forms TOML allows, and leaves one that runs this copy as it is', () => {
		const file = [
			'# my settings',
			'[mcp_servers."diff-delver"]  # ours',
			"command = 'npx'",
			'args = [',
			'  "--yes", # pinned',
			'  "https://github.com/lab273/diff-delver/releases/latest/download/diff-delver.tgz",',
			'  "\\u006dcp",',
			']',
			'startup_timeout_sec = 20',
			''
		].join('\n');
		expect(findCodexEntry(file)).toMatchObject({ kind: 'table', runs: RUNS });
		expect(addCodexEntry(file, ENTRY, RUNS)).toEqual({ kind: 'unchanged' });
	});

	it('replaces only what a table that runs something else runs, keeping its other settings and every other byte', () => {
		const before = [
			'[mcp_servers.diff-delver]',
			'command = "node"  # an old clone',
			'args = [',
			'  "/old/bin/diff-delver.js",',
			'  "mcp",',
			']',
			'startup_timeout_sec = 30',
			'',
			'[mcp_servers.diff-delver.env]',
			'A = "1"'
		].join('\n');
		const file = [
			'model = "o3"',
			'',
			'[mcp_servers.other]',
			'command = "x"',
			'',
			before,
			'',
			'# about the next one',
			'[profiles.fast]',
			'model = "mini"',
			''
		].join('\n');
		const [, commandLine = '', argsLine = ''] = ENTRY.split('\n');
		const after = [
			'[mcp_servers.diff-delver]',
			commandLine,
			argsLine,
			'startup_timeout_sec = 30',
			'',
			'[mcp_servers.diff-delver.env]',
			'A = "1"'
		].join('\n');
		expect(addCodexEntry(file, ENTRY, RUNS)).toEqual({
			kind: 'replaced',
			before,
			text: file.replace(before, after)
		});
		// A table with neither gets both, after its header.
		expect(addCodexEntry('[mcp_servers.diff-delver]\nenabled = false\n', ENTRY, RUNS)).toEqual({
			kind: 'replaced',
			before: '[mcp_servers.diff-delver]\nenabled = false',
			text: `${ENTRY}\nenabled = false\n`
		});
	});

	it('keeps a CRLF file CRLF, and its comments where they were, through setup and undo', () => {
		const crlf = (lines: readonly string[]): string => lines.join('\r\n');
		const file = crlf([
			'model = "o3"',
			'',
			'[mcp_servers.diff-delver]',
			'command = "node"',
			'args = ["/old.js", "mcp"]',
			'',
			'# about the next one',
			'[profiles.fast]',
			'model = "mini"',
			''
		]);
		const replaced = addCodexEntry(file, ENTRY, RUNS);
		expect(replaced).toEqual({
			kind: 'replaced',
			before: '[mcp_servers.diff-delver]\ncommand = "node"\nargs = ["/old.js", "mcp"]',
			text: file.replace(
				'command = "node"\r\nargs = ["/old.js", "mcp"]',
				ENTRY.split('\n').slice(1).join('\r\n')
			)
		});
		if (replaced.kind !== 'replaced') throw new Error('not replaced');
		expect(removeCodexEntry(replaced.text, RUNS)).toEqual({
			kind: 'removed',
			text: crlf([
				'model = "o3"',
				'',
				'# about the next one',
				'[profiles.fast]',
				'model = "mini"',
				''
			])
		});
		const plain = crlf(['model = "o3"', '# last', '']);
		const added = addCodexEntry(plain, ENTRY, RUNS);
		expect(added).toEqual({
			kind: 'added',
			text: `${plain}\r\n${ENTRY.split('\n').join('\r\n')}\r\n`
		});
		if (added.kind !== 'added') throw new Error('not added');
		expect(removeCodexEntry(added.text, RUNS)).toEqual({ kind: 'removed', text: plain });
	});

	it('takes no line inside a string or a value that spans lines for a table header', () => {
		const file = [
			'notes = """',
			'[mcp_servers.diff-delver]',
			'command = "fake"',
			'"""',
			"other = '''",
			'[mcp_servers.diff-delver]',
			"'''",
			'list = [',
			'  [1, 2],',
			']',
			'[mcp_servers.diff-delver]',
			'command = "npx"',
			`args = ${JSON.stringify(RUNS.args).replaceAll(',', ', ')}`,
			''
		].join('\n');
		const found = findCodexEntry(file);
		expect(found).toMatchObject({ kind: 'table', runs: RUNS });
		if (found.kind === 'table') expect(file.slice(0, found.start).endsWith(']\n')).toBe(true);
	});

	it('leaves alone an entry for diff delver it cannot change without parsing the whole file', () => {
		for (const file of [
			'[mcp_servers]\ndiff-delver = { command = "npx" }\n',
			'[mcp_servers]\n"diff-delver".command = "npx"\n',
			'mcp_servers.diff-delver.command = "npx"\n',
			'mcp_servers = { other = { command = "x" } }\n'
		]) {
			expect(addCodexEntry(file, ENTRY, RUNS)).toEqual({ kind: 'elsewhere' });
			expect(removeCodexEntry(file, RUNS)).toEqual({ kind: 'elsewhere' });
		}
		// Other servers under [mcp_servers] are not ours.
		expect(addCodexEntry('[mcp_servers]\nother.command = "x"\n', ENTRY, RUNS).kind).toBe('added');
	});

	it('undoes setup, giving back the file as it was', () => {
		const files = fc.constantFrom(
			'',
			'model = "o3"\n',
			'model = "o3"\n\n[profiles.a]\nx = 1\n',
			'# only a comment\n'
		);
		fc.assert(
			fc.property(files, (file) => {
				const added = addCodexEntry(file, ENTRY, RUNS);
				if (added.kind !== 'added') throw new Error('not added');
				expect(removeCodexEntry(added.text, RUNS)).toEqual({ kind: 'removed', text: file });
			})
		);
		const middle = 'a = 1\n\n[mcp_servers.diff-delver]\ncommand = "npx"\nargs = []\n\n[b]\nc = 2\n';
		expect(removeCodexEntry(middle, { command: 'npx', args: [] })).toEqual({
			kind: 'removed',
			text: 'a = 1\n\n[b]\nc = 2\n'
		});
	});

	it('does not undo a table that runs another copy, and says what it runs', () => {
		const file = `${codexConfigEntry(build)}\n`;
		expect(removeCodexEntry(file, RUNS)).toEqual({
			kind: 'other',
			before: codexConfigEntry(build)
		});
		expect(removeCodexEntry('model = "o3"\n', RUNS)).toEqual({ kind: 'none' });
	});

	it('writes and reads back any path a build can be in', () => {
		fc.assert(
			fc.property(
				fc.string({ unit: 'binary' }).filter((folder) => parseAbsolutePath(`/x${folder}`).ok),
				(folder) => {
					const odd: AgentServerSetup = {
						...build,
						copy: { kind: 'build', entry: path(`/x${folder}/bin.js`), node: path('/n') }
					};
					const added = addCodexEntry('', codexConfigEntry(odd), runs(odd));
					if (added.kind !== 'added') throw new Error('not added');
					expect(findCodexEntry(added.text)).toMatchObject({ kind: 'table', runs: runs(odd) });
				}
			)
		);
	});
});

describe('the skill file', () => {
	const skill = '---\nname: diff-delver\ndescription: Sort.\n---\n\n# Sorting\n';

	it('is marked after its front matter, which stays first', () => {
		const installed = installedSkill(skill);
		expect(installed.startsWith('---\nname: diff-delver\ndescription: Sort.\n---\n')).toBe(true);
		expect(installed).toContain(SKILL_MARK);
		expect(isSetupSkill(installed)).toBe(true);
		expect(isSetupSkill(skill)).toBe(false);
	});

	it('is added, kept, updated, or left when setup did not put it there', () => {
		expect(skillChange(undefined, skill)).toBe('add');
		expect(skillChange(installedSkill(skill), skill)).toBe('unchanged');
		expect(skillChange(installedSkill('---\nname: old\n---\n'), skill)).toBe('update');
		expect(skillChange(skill, skill)).toBe('unchanged');
		expect(skillChange('# My own notes\n', skill)).toBe('theirs');
	});
});

describe('what setup says', () => {
	const claude = {
		agent: 'claudeCode',
		found: true,
		configFile: path('/home/r/.claude.json'),
		skillFile: path('/home/r/.claude/skills/diff-delver/SKILL.md')
	} as const;

	it('says what it did for each agent, how to undo it, and how to set up one it did not find', () => {
		const results: SetupResult[] = [
			{ ...claude, server: { kind: 'added' }, skill: { kind: 'added' } },
			{ agent: 'codex', found: false, configFile: path('/home/r/.codex/config.toml') }
		];
		const text = describeSetup(results, release).join('\n');
		expect(text).toContain('Claude Code:\n  - Added the MCP server diff-delver, in ~/.claude.json');
		expect(text).toContain('Added the skill, ~/.claude/skills/diff-delver/SKILL.md.');
		expect(text).toContain('Codex: not found');
		expect(text).toContain(`      ${ENTRY.split('\n').join('\n      ')}`);
		expect(text).toContain(`To take this out again, run: ${setupCommand(release, true)}`);
		expect(text).toContain('start it again');
		expect(anyFailed(results)).toBe(false);
	});

	it('says what a replaced entry ran, and that nothing changed when nothing did', () => {
		const replaced = describeSetup(
			[
				{
					...claude,
					server: { kind: 'replaced', before: 'node /old.js mcp' },
					skill: { kind: 'unchanged' }
				}
			],
			release
		).join('\n');
		expect(replaced).toContain('which ran something else. It was:\n      node /old.js mcp');
		const same = describeSetup(
			[{ ...claude, server: { kind: 'unchanged' }, skill: { kind: 'unchanged' } }],
			release
		).join('\n');
		expect(same).toContain('already set up the same way. Nothing changed.');
		expect(same).not.toContain('start it again');
	});

	it('names the data folder and the build in the undo command when they are not the defaults', () => {
		expect(setupCommand(build, true)).toBe(
			'/opt/node/bin/node ~/src/diff-delver/bin/diff-delver.js setup --data-directory ~/data --undo'
		);
		expect(setupCommand(release)).toBe(
			'npx --yes https://github.com/lab273/diff-delver/releases/latest/download/diff-delver.tgz setup'
		);
	});

	it('says plainly when it found no agent', () => {
		const text = describeSetup(
			[
				{ agent: 'claudeCode', found: false, configFile: path('/home/r/.claude.json') },
				{ agent: 'codex', found: false, configFile: path('/home/r/.codex/config.toml') }
			],
			release
		).join('\n');
		expect(text).toContain('found no coding agent');
		expect(text).toContain(
			'npx --yes https://github.com/lab273/diff-delver/releases/latest/download/diff-delver.tgz mcp'
		);
	});

	it('names the Codex folder it looked in, and shows an entry it removed when ours could not be added', () => {
		const text = describeSetup(
			[
				{
					...claude,
					server: {
						kind: 'failed',
						detail: 'claude mcp add failed: no',
						before: 'node /old.js mcp\nenv: {"A":"1"}'
					},
					skill: { kind: 'added' }
				},
				{ agent: 'codex', found: false, configFile: path('/srv/codex/config.toml') }
			],
			release
		).join('\n');
		expect(text).toContain('could not be added: claude mcp add failed: no');
		expect(text).toContain(
			'was removed first. It was:\n      node /old.js mcp\n      env: {"A":"1"}'
		);
		expect(text).toContain(
			'Codex: not found, since there is no codex command and no /srv/codex folder.'
		);
		expect(text).toContain('add this to /srv/codex/config.toml:');
		const codex = describeSetup(
			[
				{
					agent: 'codex',
					found: true,
					configFile: path('/home/r/.codex/config.toml'),
					skillFile: path('/home/r/.codex/skills/diff-delver/SKILL.md'),
					server: { kind: 'replaced', before: '[mcp_servers.diff-delver]\ncommand = "node"' },
					skill: { kind: 'unchanged' }
				}
			],
			release
		).join('\n');
		expect(codex).toContain(
			'its other settings are kept. It was:\n      [mcp_servers.diff-delver]'
		);
	});

	it('says what undo removed and what it left', () => {
		const text = describeUndo(
			[
				{
					...claude,
					server: { kind: 'other', before: 'node /x.js mcp' },
					skill: { kind: 'removed' }
				},
				{ agent: 'codex', found: false, configFile: path('/home/r/.codex/config.toml') }
			],
			release
		).join('\n');
		expect(text).toContain('runs something other than this copy');
		expect(text).toContain('Removed the skill, ~/.claude/skills/diff-delver/SKILL.md.');
		expect(text).toContain('Codex: not found, so there was nothing to take out.');
	});
});

describe('the command line', () => {
	it('reads setup and --undo, which goes with setup only', () => {
		expect(parseCommandLine(['setup'])).toMatchObject({
			ok: true,
			value: { command: { kind: 'setup', undo: false } }
		});
		expect(parseCommandLine(['setup', '--undo'])).toMatchObject({
			ok: true,
			value: { command: { kind: 'setup', undo: true } }
		});
		expect(parseCommandLine(['mcp', '--undo'])).toMatchObject({
			ok: false,
			error: { kind: 'UndoWithoutSetup' }
		});
		expect(parseCommandLine(['setup', 'claude'])).toMatchObject({
			ok: false,
			error: { kind: 'ExtraArgument' }
		});
	});
});
