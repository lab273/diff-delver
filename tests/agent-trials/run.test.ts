/**
 * The trial harness (`run.ts`) run as a person runs it, with stand-ins: a
 * fake `claude` or `codex` executable and a fake login in a folder of the
 * test's own, never the real ones, and never a real agent. Whatever way a run
 * ends, the link to the login and the temporary folder are gone, the login is
 * as it was (or refreshed, when the CLI refreshed it), and nothing the CLI
 * started is left running.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDirectory } from '../support/fixture-repos.ts';

const HARNESS = join(import.meta.dirname, 'run.ts');
const FAR_FUTURE = Date.UTC(2100, 0, 1);
const CLAUDE_LOGIN = JSON.stringify({ claudeAiOauth: { expiresAt: FAR_FUTURE } });

/** Where git is, for a PATH with nothing else of this machine's on it. */
function folderOf(program: string): string {
	for (const folder of (process.env['PATH'] ?? '').split(':')) {
		if (folder !== '' && existsSync(join(folder, program))) return folder;
	}
	throw new Error(`No ${program} on the PATH`);
}

interface Stage {
	readonly folder: string;
	/** The harness's temporary folder: where its trial folder is made. */
	readonly tmp: string;
	/** The fake login's folder, as `--login-from` takes it. */
	readonly login: string;
	readonly out: string;
	/** Where the stand-in writes its process ids, one a line. */
	readonly pids: string;
	/** Where the stand-in writes what it found while it ran. */
	readonly seen: string;
	readonly cli: string;
}

/**
 * A stand-in for a CLI: answers `--version`, and otherwise writes its process
 * id and then runs `body`, with `$PIDS`, `$SEEN` and `$LOGIN_LINK` (where the
 * harness linked the login) set.
 */
async function stage(agent: 'claude' | 'codex', body: string, login: string): Promise<Stage> {
	const folder = await tempDirectory();
	const paths = {
		folder,
		tmp: join(folder, 'tmp'),
		login: join(folder, 'login'),
		out: join(folder, 'out'),
		pids: join(folder, 'pids'),
		seen: join(folder, 'seen'),
		cli: join(folder, 'bin', agent)
	};
	await Promise.all([
		mkdir(paths.tmp),
		mkdir(paths.login),
		mkdir(join(folder, 'bin')),
		mkdir(join(folder, 'home'))
	]);
	await writeFile(
		join(paths.login, agent === 'claude' ? '.credentials.json' : 'auth.json'),
		login,
		{ mode: 0o600 }
	);
	const linkAt =
		agent === 'claude' ? '"$CLAUDE_CONFIG_DIR/.credentials.json"' : '"$CODEX_HOME/auth.json"';
	await writeFile(
		paths.cli,
		[
			'#!/bin/sh',
			`PIDS='${paths.pids}'`,
			`SEEN='${paths.seen}'`,
			`LOGIN_LINK=${linkAt}`,
			'if [ "$1" = "--version" ]; then echo "stand-in 1.0"; exit 0; fi',
			'if [ "$1" = "mcp" ] || [ "$1" = "debug" ]; then echo "[]"; exit 0; fi',
			'echo $$ >> "$PIDS"',
			'[ -L "$LOGIN_LINK" ] && echo "login linked" >> "$SEEN"',
			body,
			''
		].join('\n')
	);
	await chmod(paths.cli, 0o755);
	return paths;
}

interface Harness {
	readonly exit: Promise<{ readonly code: number | null; readonly output: string }>;
	readonly signal: (name: NodeJS.Signals) => void;
}

function startHarness(
	paths: Stage,
	agent: 'claude' | 'codex',
	extra: readonly string[] = []
): Harness {
	const child = spawn(
		process.execPath,
		[
			HARNESS,
			'--agent',
			agent,
			'--fixture',
			'shop',
			'--cli',
			paths.cli,
			'--login-from',
			paths.login,
			'--out',
			paths.out,
			...extra
		],
		{
			env: {
				PATH: [dirname(process.execPath), folderOf('git'), '/usr/bin', '/bin'].join(':'),
				HOME: join(paths.folder, 'home'),
				TMPDIR: paths.tmp
			},
			stdio: ['ignore', 'pipe', 'pipe']
		}
	);
	let output = '';
	child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
	child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
	return {
		exit: new Promise((resolve) => {
			child.on('close', (code) => {
				resolve({ code, output });
			});
		}),
		signal: (name) => child.kill(name)
	};
}

async function until(condition: () => Promise<boolean>): Promise<void> {
	for (let i = 0; i < 600; i += 1) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error('Waited 30 seconds.');
}

async function pidsOf(paths: Stage): Promise<readonly number[]> {
	const text = await readFile(paths.pids, 'utf8').catch(() => '');
	return text
		.split('\n')
		.filter((line) => line !== '')
		.map(Number);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** What a finished run left: the harness's temporary folder, and whether the stand-ins still run. */
async function leftBehind(paths: Stage): Promise<{
	readonly trialFolders: readonly string[];
	readonly running: readonly number[];
}> {
	const pids = await pidsOf(paths);
	await until(() => Promise.resolve(pids.every((pid) => !alive(pid)))).catch(() => undefined);
	return {
		trialFolders: (await readdir(paths.tmp)).filter((name) =>
			name.startsWith('diff-delver-trial-')
		),
		running: pids.filter(alive)
	};
}

/** Leaves `sleep` running in the background, holding the output open, then waits forever. */
const HANG = 'sleep 300 &\necho $! >> "$PIDS"\nsleep 300';

describe('the trial harness, with a stand-in CLI and login', () => {
	for (const [signal, code] of [
		['SIGINT', 130],
		['SIGTERM', 143]
	] as const) {
		it(`stopped with ${signal}, stops the CLI and what it started, takes out the login and its folder, and records nothing`, async () => {
			const paths = await stage('claude', HANG, CLAUDE_LOGIN);
			const harness = startHarness(paths, 'claude');
			await until(async () => (await pidsOf(paths)).length === 2);
			harness.signal(signal);
			const { code: exitCode, output } = await harness.exit;
			expect(output).toContain(`${signal}: stopping the trial and cleaning up.`);
			expect(output).toContain('nothing was recorded');
			expect(exitCode).toBe(code);
			expect(await readFile(paths.seen, 'utf8')).toBe('login linked\n');
			expect(await leftBehind(paths)).toEqual({ trialFolders: [], running: [] });
			expect(existsSync(paths.out)).toBe(false);
			expect(await readFile(join(paths.login, '.credentials.json'), 'utf8')).toBe(CLAUDE_LOGIN);
		});
	}

	it('with a CLI that is not there, says so and leaves nothing behind', async () => {
		const paths = await stage('claude', 'exit 0', CLAUDE_LOGIN);
		const missing = join(paths.folder, 'bin', 'absent');
		const { code, output } = await startHarness({ ...paths, cli: missing }, 'claude').exit;
		expect(code).toBe(1);
		expect(output).toContain(`Could not run ${missing}`);
		expect(output).toContain('Install the CLI and log in to it');
		expect(await leftBehind(paths)).toEqual({ trialFolders: [], running: [] });
		expect(await readFile(join(paths.login, '.credentials.json'), 'utf8')).toBe(CLAUDE_LOGIN);
	});

	it('at the time limit, stops a CLI whose child holds its output, and records the limit', async () => {
		const paths = await stage('claude', HANG, CLAUDE_LOGIN);
		const { code, output } = await startHarness(paths, 'claude', ['--time-limit', '1']).exit;
		expect(output).toContain('Outcome: time-limit (Stopped after 1 seconds.)');
		expect(code).toBe(0);
		expect(await leftBehind(paths)).toEqual({ trialFolders: [], running: [] });
		expect(JSON.parse(await readFile(join(paths.out, 'shop.claude.json'), 'utf8'))).toMatchObject({
			outcome: 'time-limit'
		});
	});

	it('after a CLI that exits leaving a child holding its output, is done, and the child stopped', async () => {
		const paths = await stage('claude', 'sleep 300 &\necho $! >> "$PIDS"\nexit 0', CLAUDE_LOGIN);
		const { output } = await startHarness(paths, 'claude').exit;
		expect(output).toContain('Outcome: failed');
		expect(await leftBehind(paths)).toEqual({ trialFolders: [], running: [] });
	});

	for (const agent of ['claude', 'codex'] as const) {
		it(`puts back a login ${agent} refreshed during a run that failed, and says so`, async () => {
			const file = agent === 'claude' ? '.credentials.json' : 'auth.json';
			const own =
				agent === 'claude' ? CLAUDE_LOGIN : JSON.stringify({ tokens: { access_token: 'a.e30.b' } });
			const paths = await stage(
				agent,
				'printf refreshed > "$LOGIN_LINK.new" && mv -f "$LOGIN_LINK.new" "$LOGIN_LINK"\nexit 3',
				own
			);
			const { output } = await startHarness(paths, agent).exit;
			expect(output).toContain('Outcome: failed');
			expect(output).toContain(
				`The CLI refreshed its login during the trial. The refreshed login was put in place of yours at ${join(paths.login, file)}`
			);
			expect(await readFile(join(paths.login, file), 'utf8')).toBe('refreshed');
			expect(await readdir(paths.login)).toEqual([file]);
			expect(await leftBehind(paths)).toEqual({ trialFolders: [], running: [] });
		});
	}
});
