import { describe, expect, it } from 'vitest';
import { describeCommandLineError, HELP_TEXT, parseCommandLine } from './command-line.ts';

describe('the command line', () => {
	it('opens what is most likely to be reviewed with no arguments', () => {
		expect(parseCommandLine([])).toEqual({
			ok: true,
			value: { command: { kind: 'start' }, noOpen: false, dataDirectory: undefined }
		});
	});

	it('reads open with each kind of source', () => {
		expect(parseCommandLine(['open', 'staged'])).toMatchObject({
			ok: true,
			value: { command: { kind: 'open', source: { kind: 'staged' } } }
		});
		expect(parseCommandLine(['open', '--staged'])).toMatchObject({
			ok: true,
			value: { command: { kind: 'open', source: { kind: 'staged' } } }
		});
		expect(parseCommandLine(['open', 'main...feature-x', '--no-open'])).toMatchObject({
			ok: true,
			value: {
				command: { kind: 'open', source: { kind: 'range', from: 'main', to: 'feature-x' } },
				noOpen: true
			}
		});
		expect(parseCommandLine(['open', 'HEAD'])).toMatchObject({
			ok: true,
			value: { command: { kind: 'open', source: { kind: 'commit', revision: 'HEAD' } } }
		});
	});

	it('reads the data folder in both spellings', () => {
		expect(parseCommandLine(['--data-directory', 'here', 'serve'])).toMatchObject({
			ok: true,
			value: { command: { kind: 'serve' }, dataDirectory: 'here' }
		});
		expect(parseCommandLine(['stop', '--data-directory=/data'])).toMatchObject({
			ok: true,
			value: { command: { kind: 'stop' }, dataDirectory: '/data' }
		});
	});

	it('reads mcp, the shim agents start, with its options', () => {
		expect(parseCommandLine(['mcp', '--no-open', '--data-directory', '/data'])).toEqual({
			ok: true,
			value: { command: { kind: 'mcp' }, noOpen: true, dataDirectory: '/data' }
		});
		expect(parseCommandLine(['mcp', 'extra']).ok).toBe(false);
		expect(HELP_TEXT).toMatch(/diff-delver mcp {13}For coding agents: an MCP server/);
	});

	it('shows help and the version before anything else', () => {
		expect(parseCommandLine(['open', 'HEAD', '--help'])).toMatchObject({
			ok: true,
			value: { command: { kind: 'help' } }
		});
		expect(parseCommandLine(['-v'])).toMatchObject({
			ok: true,
			value: { command: { kind: 'version' } }
		});
		expect(parseCommandLine(['help'])).toMatchObject({
			ok: true,
			value: { command: { kind: 'help' } }
		});
	});

	it.each([
		[['frobnicate'], 'UnknownCommand', /no command "frobnicate"/],
		[['--colour'], 'UnknownOption', /no option --colour/],
		[['open'], 'MissingSource', /needs what to open/],
		[['open', 'main', 'feature'], 'ExtraArgument', /did not expect "feature"/],
		[['serve', 'now'], 'ExtraArgument', /did not expect "now"/],
		[['--data-directory'], 'MissingOptionValue', /needs a folder/],
		[['--data-directory='], 'MissingOptionValue', /needs a folder/],
		[['open', ' main ... x '], 'InvalidSource', /./]
	])('says what is wrong with %j', (args, kind, message) => {
		const parsed = parseCommandLine(args);
		expect(parsed).toMatchObject({ ok: false, error: { kind } });
		if (!parsed.ok) expect(describeCommandLineError(parsed.error)).toMatch(message);
	});

	it('takes everything after -- as words', () => {
		expect(parseCommandLine(['open', '--', '-weird'])).toMatchObject({ ok: false });
		expect(parseCommandLine(['--', 'serve'])).toMatchObject({
			ok: true,
			value: { command: { kind: 'serve' } }
		});
	});

	it('has help that names every command and option', () => {
		for (const word of [
			'open',
			'serve',
			'stop',
			'--no-open',
			'--data-directory',
			'--help',
			'--version'
		]) {
			expect(HELP_TEXT).toContain(word);
		}
	});
});
