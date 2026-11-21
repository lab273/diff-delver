/**
 * What the trial harness hands each agent CLI, and how it runs one, tested
 * without starting a session: the exact arguments and settings that keep the
 * agent to reading the trial's copy of the repository, the login linked in and
 * taken out (a refreshed one put back), and runs stopped whole at their limit.
 */
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDirectory } from '../support/fixture-repos.ts';
import {
	checkLoginFresh,
	claudeArguments,
	codexArguments,
	codexConfig,
	linkLogin,
	loginExpiresAt,
	releaseLogin,
	runBounded
} from './agent-cli.ts';

const NOW = Date.UTC(2026, 10, 21, 12);

describe('what Claude Code is given', () => {
	const trial = {
		prompt: 'Sort it.',
		model: 'opus',
		turnLimit: 120,
		repository: '/tmp/trial/work/shop',
		home: '/tmp/trial/home',
		loginFolder: '/home/someone/.claude',
		mcpConfig: '/tmp/trial/mcp.json'
	};

	it('reads only the repository, with no shell and nothing that writes', () => {
		expect(claudeArguments({ ...trial, plugin: '/tmp/trial/plugin' })).toEqual([
			'-p',
			'Sort it.',
			'--model',
			'opus',
			'--output-format',
			'stream-json',
			'--verbose',
			'--no-session-persistence',
			'--strict-mcp-config',
			'--mcp-config',
			'/tmp/trial/mcp.json',
			'--permission-mode',
			'dontAsk',
			'--permission-prompts',
			'none',
			'--tools',
			'Read,Grep,Glob,Skill',
			'--allowedTools',
			'Read(//tmp/trial/work/shop/**)',
			'mcp__diff-delver',
			'Skill',
			'--disallowedTools',
			'Bash',
			'Edit',
			'Write',
			'NotebookEdit',
			'WebFetch',
			'WebSearch',
			'Read(//tmp/trial/home/**)',
			'Read(//home/someone/.claude/**)',
			'--max-turns',
			'120',
			'--plugin-dir',
			'/tmp/trial/plugin'
		]);
	});

	it('has no Skill tool and no plugin without the skill, and never a flag that skips permissions', () => {
		const args = claudeArguments({ ...trial, plugin: undefined });
		expect(args).not.toContain('Skill');
		expect(args).not.toContain('--plugin-dir');
		expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
		const allowed = args.slice(
			args.indexOf('--allowedTools') + 1,
			args.indexOf('--disallowedTools')
		);
		expect(allowed).toEqual(['Read(//tmp/trial/work/shop/**)', 'mcp__diff-delver']);
		expect(args.filter((a) => /dangerously|bypass|skip|add-dir/i.test(a))).toEqual([]);
	});
});

describe('what Codex is given', () => {
	const trial = {
		model: 'gpt-6.2-sol',
		repository: '/tmp/trial/work/shop',
		installation: '/opt/codex/0.170.0',
		skills: '/tmp/trial/home/.codex/skills',
		server: { command: '/usr/bin/node', args: ['proxy.ts', '--', 'diff-delver', 'mcp'] }
	};

	it('runs commands in a sandbox that reads the repository and writes nothing', () => {
		const config = codexConfig(trial);
		expect(config.split('\n').slice(0, 10)).toEqual([
			'model = "gpt-6.2-sol"',
			'approval_policy = "never"',
			'default_permissions = "trial"',
			'',
			'[permissions.trial.filesystem]',
			'":minimal" = "read"',
			'"/tmp/trial/work/shop" = "read"',
			'"/opt/codex/0.170.0" = "read"',
			'"/tmp/trial/home/.codex/skills" = "read"',
			''
		]);
		// No other mode, no folder it may write, and the image tool, which reads any path, off.
		expect(config).not.toMatch(/sandbox_mode|"write"|danger|full-access/);
		expect(config).toContain('\nview_image = false\n');
		expect(config).toContain('\n[agents]\nenabled = false\n');
		expect(config).toContain(
			'[mcp_servers.diff-delver]\ncommand = "/usr/bin/node"\nargs = ["proxy.ts", "--", "diff-delver", "mcp"]\n'
		);
	});

	it('is started with no flag that loosens the sandbox', () => {
		expect(
			codexArguments({
				prompt: 'Sort it.',
				model: 'gpt-6.2-sol',
				repository: '/tmp/trial/work/shop',
				lastMessage: '/tmp/trial/last.txt'
			})
		).toEqual([
			'exec',
			'--json',
			'--strict-config',
			'--ephemeral',
			'--ignore-rules',
			'-m',
			'gpt-6.2-sol',
			'-C',
			'/tmp/trial/work/shop',
			'-o',
			'/tmp/trial/last.txt',
			'Sort it.'
		]);
	});
});

/** A token as Codex keeps it: three base64url parts, the middle one its claims. */
function token(claims: object): string {
	const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${part({ alg: 'none' })}.${part(claims)}.signature`;
}

describe('the login', () => {
	it('says when each CLI’s login expires, from its own file', () => {
		const claude = JSON.stringify({ claudeAiOauth: { expiresAt: NOW + 5 * 60_000 } });
		expect(loginExpiresAt('claude', claude)).toBe(NOW + 5 * 60_000);
		const codex = JSON.stringify({ tokens: { access_token: token({ exp: NOW / 1000 + 300 }) } });
		expect(loginExpiresAt('codex', codex)).toBe(NOW + 300_000);
		expect(loginExpiresAt('codex', JSON.stringify({ OPENAI_API_KEY: 'k' }))).toBeUndefined();
		expect(loginExpiresAt('codex', 'not json')).toBeUndefined();
	});

	it('refuses a login due to be refreshed within 20 minutes, for either CLI', async () => {
		const folder = await tempDirectory();
		const soon = join(folder, 'soon.json');
		const later = join(folder, 'later.json');
		await writeFile(
			soon,
			JSON.stringify({ tokens: { access_token: token({ exp: NOW / 1000 + 600 }) } })
		);
		await writeFile(
			later,
			JSON.stringify({ tokens: { access_token: token({ exp: NOW / 1000 + 3600 }) } })
		);
		expect(() => {
			checkLoginFresh('codex', soon, NOW);
		}).toThrow('Your Codex login is due to be refreshed within 20 minutes.');
		checkLoginFresh('codex', later, NOW);
		await writeFile(soon, JSON.stringify({ claudeAiOauth: { expiresAt: NOW + 60_000 } }));
		expect(() => {
			checkLoginFresh('claude', soon, NOW);
		}).toThrow('Your Claude Code login is due to be refreshed within 20 minutes.');
		expect(() => {
			checkLoginFresh('claude', join(folder, 'none.json'), NOW);
		}).toThrow('No login at');
	});

	async function linked(): Promise<{
		readonly real: string;
		readonly link: string;
		readonly login: ReturnType<typeof linkLogin>;
	}> {
		const folder = await tempDirectory();
		const real = join(folder, 'own', '.credentials.json');
		await mkdir(join(folder, 'own'));
		await writeFile(real, 'the person’s login', { mode: 0o600 });
		const link = join(folder, 'trial', 'home', '.claude', '.credentials.json');
		return { real, link, login: linkLogin(real, link) };
	}

	it('is linked, never copied, and the link taken out leaves the login as it was', async () => {
		const { real, link, login } = await linked();
		expect(await readlink(link)).toBe(real);
		expect(releaseLogin(login, new Date(NOW))).toEqual([]);
		expect(existsSync(link)).toBe(false);
		expect(await readFile(real, 'utf8')).toBe('the person’s login');
		expect(releaseLogin(login, new Date(NOW))).toEqual([]);
	});

	it('refreshed by the CLI, which replaced the link, is put in place of the person’s', async () => {
		const { real, link, login } = await linked();
		await writeFile(`${link}.new`, 'refreshed');
		spawnSync('mv', ['-f', `${link}.new`, link]);
		const notes = releaseLogin(login, new Date(NOW));
		expect(notes).toEqual([
			`The CLI refreshed its login during the trial. The refreshed login was put in place of yours at ${real}, since the one there was refreshed.`
		]);
		expect(await readFile(real, 'utf8')).toBe('refreshed');
		expect((await stat(real)).mode & 0o777).toBe(0o600);
		expect(existsSync(link)).toBe(false);
		expect(readdirSync(join(real, '..'))).toEqual(['.credentials.json']);
	});

	it('refreshed by the CLI while the person’s own changed too, is kept beside it', async () => {
		const { real, link, login } = await linked();
		await writeFile(`${link}.new`, 'refreshed in the trial');
		spawnSync('mv', ['-f', `${link}.new`, link]);
		await writeFile(real, 'refreshed by the person');
		const kept = `${real}.from-trial-2026-11-21T12-00-00-000Z`;
		expect(releaseLogin(login, new Date(NOW))).toEqual([
			`The CLI refreshed its login during the trial, and yours at ${real} changed meanwhile, so it was left as it is. The refreshed login is kept at ${kept}: if the CLI asks you to log in again, move that file over yours, or log in.`
		]);
		expect(await readFile(real, 'utf8')).toBe('refreshed by the person');
		expect(await readFile(kept, 'utf8')).toBe('refreshed in the trial');
		expect((await stat(kept)).mode & 0o777).toBe(0o600);
		expect(existsSync(link)).toBe(false);
	});
});

/** Whether a process is still running. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Waits, up to a few seconds, for a process to be gone. */
async function gone(pid: number): Promise<boolean> {
	for (let i = 0; i < 100 && alive(pid); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return !alive(pid);
}

/**
 * A shell script that writes its process id, and those of what it starts, to
 * the file `$PIDS`.
 */
async function script(body: string): Promise<{ readonly path: string; readonly pids: string }> {
	const folder = await tempDirectory();
	const pids = join(folder, 'pids');
	const path = join(folder, 'program');
	await writeFile(path, `#!/bin/sh\nPIDS='${pids}'\necho $$ >> "$PIDS"\n${body}\n`);
	await chmod(path, 0o755);
	return { path, pids };
}

async function pidsIn(file: string): Promise<readonly number[]> {
	return (await readFile(file, 'utf8'))
		.split('\n')
		.filter((line) => line !== '')
		.map(Number);
}

describe('running a CLI', () => {
	it('does not wait for something the program left holding its output, and stops it', async () => {
		const { path, pids } = await script(`sleep 300 &\necho $! >> "$PIDS"\necho done\nexit 0`);
		const run = await runBounded(path, [], { limitMs: 60_000 });
		expect([run.code, run.timedOut, run.stdout]).toEqual([0, false, 'done\n']);
		for (const pid of await pidsIn(pids)) expect(await gone(pid)).toBe(true);
	});

	it('stops the whole process group at the time limit', async () => {
		const { path, pids } = await script(`sleep 300 &\necho $! >> "$PIDS"\nsleep 300`);
		const run = await runBounded(path, [], { limitMs: 300 });
		expect(run.timedOut).toBe(true);
		const started = await pidsIn(pids);
		expect(started).toHaveLength(2);
		for (const pid of started) expect(await gone(pid)).toBe(true);
	});

	it('stops the whole process group when asked to stop', async () => {
		const { path, pids } = await script(`sleep 300 &\necho $! >> "$PIDS"\nsleep 300`);
		const stop = new AbortController();
		const running = runBounded(path, [], {
			limitMs: 60_000,
			stop: stop.signal
		});
		for (
			let i = 0;
			i < 100 && (await readFile(pids, 'utf8').catch(() => '')).split('\n').length < 3;
			i += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		stop.abort('SIGINT');
		const run = await running;
		expect([run.stopped, run.timedOut]).toEqual([true, false]);
		for (const pid of await pidsIn(pids)) expect(await gone(pid)).toBe(true);
	});

	it('says why a program that is not there could not be run', async () => {
		const folder = await tempDirectory();
		const run = await runBounded(join(folder, 'claude'), ['--version'], { limitMs: 60_000 });
		expect(run.error).toMatch(/ENOENT/);
		expect(run.code).toBeNull();
	});
});
