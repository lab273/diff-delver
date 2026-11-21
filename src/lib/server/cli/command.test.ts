/**
 * The real `diff-delver` command, run as a process from the build with
 * `--no-open`, as a person runs it: in a fixture repository, with a temporary
 * data folder and a git setup of the test's own. The daemons it starts run in
 * the background and are stopped when each test finishes.
 */
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { HELP_TEXT } from '#lib/core/cli/command-line.ts';
import { tokenCookieName } from '#lib/core/daemon/request-gate.ts';
import { parseDaemonToken } from '#lib/core/daemon-token.tiny.ts';
import { parseProcessId } from '#lib/core/process-id.tiny.ts';
import { BUILT_COMMAND } from '../../../../tests/support/build.ts';
import { clientOf, rawRequest, testDaemon, version } from '../../../../tests/support/daemons.ts';
import { listingsAround } from '../../../../tests/support/directory-listing.ts';
import {
	defineFixture,
	emptyRepo,
	tempDirectory,
	useFixture
} from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { reviewer, type Reviewer } from '../../../../tests/support/reviewer-git.ts';
import { readLockfile } from '../daemon/lockfile.ts';
import { processExists } from '../daemon/probe.ts';

const edited = defineFixture('command-edited', async (repo) => {
	await repo.write('src/a.ts', 'export const a = 1;\n');
	await repo.commit('base');
	await repo.write('src/a.ts', 'export const a = 2;\n');
	await repo.write('src/b.ts', 'export const b = 1;\n');
});

interface Ran {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** The environment the command runs in: the test's git setup, and no display, so no browser could open. */
function environment(
	who: Reviewer,
	extra: Readonly<Record<string, string>> = {}
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, ...who.gitEnv };
	delete env['DISPLAY'];
	delete env['WAYLAND_DISPLAY'];
	delete env['DIFF_DELVER_DATA_DIRECTORY'];
	return { ...env, ...extra };
}

function run(
	args: readonly string[],
	cwd: string,
	who: Reviewer,
	extra: Readonly<Record<string, string>> = {}
): Promise<Ran> {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[BUILT_COMMAND, ...args],
			{ cwd, env: environment(who, extra) },
			(error, stdout, stderr) => {
				const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
				resolve({ code, stdout, stderr });
			}
		);
	});
}

/** Stops the daemon of `dataDirectory` when the test finishes, as `diff-delver stop` does. */
function stopAfterwards(dataDirectory: string, who: Reviewer): void {
	onTestFinished(async () => {
		await run(['stop', '--data-directory', dataDirectory], dataDirectory, who);
	});
}

/** The address the command printed. */
function addressIn(output: string): URL {
	const match = /Open this in your browser: (\S+)/.exec(output);
	if (match?.[1] === undefined) throw new Error(`No address in: ${output}`);
	return new URL(match[1]);
}

async function setUp(): Promise<{ who: Reviewer; data: AbsolutePath }> {
	const who = await reviewer();
	const data = await tempDirectory();
	stopAfterwards(data, who);
	return { who, data };
}

describe('the diff-delver command', () => {
	it('opens the uncommitted changes in a background daemon and prints where, writing nothing to the repository', async () => {
		const repo = await useFixture(edited);
		const { who, data } = await setUp();
		const { before, after, result } = await listingsAround([repo.dir], () =>
			run(['--no-open', '--data-directory', data], repo.dir, who)
		);
		expect(after).toEqual(before);
		expect(result.code).toBe(0);
		const lines = result.stdout.trimEnd().split('\n');
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe(
			`Uncommitted changes in ${repo.dir.split('/').at(-1) ?? ''}: 2 files changed, 2 lines added and 1 removed.`
		);
		const address = addressIn(result.stdout);
		expect(address.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(address.pathname).toMatch(/^\/diffs\/r_[0-9a-f]{16}$/);
		expect(lines[2]).toBe(
			'The address works once, within two minutes; run diff-delver again for a new one.'
		);

		// The daemon outlives the command, and the address lets a browser in once.
		// It holds a single-use code, never the daemon's token.
		const lock = await readLockfile(data);
		if (lock.kind !== 'lock') throw new Error('no lock');
		expect(address.port).toBe(String(lock.lock.port));
		expect(address.href).not.toContain(lock.lock.token);
		expect(address.searchParams.get('entry')).toMatch(/^[0-9a-f]{32}$/);
		const entered = await rawRequest(lock.lock.port, {
			path: `${address.pathname}${address.search}`
		});
		expect(entered.status).toBe(303);
		expect(entered.headers['location']).toBe(address.pathname);
		const reused = await rawRequest(lock.lock.port, {
			path: `${address.pathname}${address.search}`
		});
		expect(reused.status).toBe(403);
		expect(reused.body).toContain('This link is out of date');
		const page = await rawRequest(lock.lock.port, {
			path: address.pathname,
			headers: { cookie: `${tokenCookieName(lock.lock.port)}=${lock.lock.token}` }
		});
		expect(page.status).toBe(200);
		expect(page.body).toContain('Uncommitted changes');

		// Run again, it finds the same daemon and the same diff.
		const again = await run(['--no-open', '--data-directory', data], repo.dir, who);
		expect(again.stdout).toContain(
			'opened again where you left it (not started: 3 changes to review)'
		);
		expect(addressIn(again.stdout).pathname).toBe(address.pathname);
	});

	it('opens a named source, and says when it has nothing to review', async () => {
		const repo = await useFixture(edited);
		const { who, data } = await setUp();
		const staged = await run(
			['open', 'staged', '--no-open', '--data-directory', data],
			repo.dir,
			who
		);
		expect(staged.code).toBe(0);
		expect(staged.stdout).toMatch(/^Nothing is staged/);
		expect(addressIn(staged.stdout).pathname).toBe('/start');
		expect(addressIn(staged.stdout).searchParams.get('asked')).toBe('staged');

		const commit = await run(
			['open', 'HEAD', '--no-open', '--data-directory', data],
			repo.dir,
			who
		);
		expect(commit.code).toBe(0);
		expect(commit.stdout).toMatch(/^The last commit in [^:]+: 1 file changed, 1 line added\.\n/);

		// A mistyped source opens the page that says what was asked for and why it failed.
		const mistyped = await run(
			['open', 'mian...HEAD', '--no-open', '--data-directory', data],
			repo.dir,
			who
		);
		expect(mistyped.code).toBe(1);
		expect(mistyped.stderr).toContain('mian');
		expect(addressIn(mistyped.stdout).pathname).toBe('/start');
		expect(addressIn(mistyped.stdout).searchParams.get('asked')).toBe('mian...HEAD');

		// The choose page, for this repository.
		const choose = await run(['choose', '--no-open', '--data-directory', data], repo.dir, who);
		expect(choose.code).toBe(0);
		expect(choose.stdout).toMatch(
			/^Choose commits, or a whole branch, to review in [^,]+, in your browser\.\n/
		);
		expect(addressIn(choose.stdout).pathname).toBe('/choose');
		expect(addressIn(choose.stdout).searchParams.get('directory')).toBe(repo.dir);
	});

	it('says plainly when the folder is not a repository, and opens the page that says so', async () => {
		const { who, data } = await setUp();
		const folder = await tempDirectory();
		const result = await run(['--no-open', '--data-directory', data], folder, who);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`${folder} is not a git repository.`);
		expect(result.stderr).not.toMatch(/\n\s+at /);
		expect(addressIn(result.stdout).pathname).toBe('/start');
		const choose = await run(['choose', '--no-open', '--data-directory', data], folder, who);
		expect(choose.code).toBe(1);
		// What it says to do is something the command can do: it takes no path.
		expect(choose.stderr).toContain(
			`${folder} is not a git repository. Run diff delver in a folder inside the repository you want to review.`
		);
		expect(addressIn(choose.stdout).pathname).toBe('/choose');
	});

	it('takes its data folder from the environment when no option names one', async () => {
		const repo = await useFixture(edited);
		const { who, data } = await setUp();
		const result = await run(['--no-open'], repo.dir, who, { DIFF_DELVER_DATA_DIRECTORY: data });
		expect(result.code).toBe(0);
		expect(await readLockfile(data)).toMatchObject({ kind: 'lock' });
	});

	it('says plainly when the data folder cannot be written', async () => {
		const repo = await useFixture(edited);
		const who = await reviewer();
		const file = join(await tempDirectory(), 'a-file');
		await writeFile(file, 'not a folder');
		const result = await run(['--no-open', '--data-directory', file], repo.dir, who);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`diff delver could not write to its data folder ${file}`);
		expect(result.stderr).not.toMatch(/\n\s+at /);
	});

	it('starts a new daemon in place of a stale one, and stops it on diff-delver stop', async () => {
		const repo = await useFixture(edited);
		const { who, data } = await setUp();
		// A lockfile left by a daemon that was killed: its process and port are gone.
		await writeFile(
			join(data, 'daemon.lock'),
			JSON.stringify({
				port: 9,
				pid: 999_999_999,
				token: 'a'.repeat(64),
				version: 'gone',
				startedAt: 1
			})
		);
		const result = await run(['--no-open', '--data-directory', data], repo.dir, who);
		expect(result.code).toBe(0);
		const lock = await readLockfile(data);
		expect(lock).toMatchObject({ kind: 'lock' });
		expect(lock.kind === 'lock' && lock.lock.port).not.toBe(9);

		const stopped = await run(['stop', '--data-directory', data], data, who);
		expect(stopped.stdout).toBe('diff delver has stopped.\n');
		expect(await readLockfile(data)).toEqual({ kind: 'none' });
		const again = await run(['stop', '--data-directory', data], data, who);
		expect(again.stdout).toBe('diff delver is not running.\n');
	});

	it('never signals a process a stale lockfile names, when no daemon answers for it', async () => {
		const { who, data } = await setUp();
		// Any program, given the id a daemon that was killed once had.
		const other = spawn('sleep', ['60'], { stdio: 'ignore' });
		onTestFinished(() => {
			other.kill();
		});
		const pid = await new Promise<number>((resolve, reject) => {
			other.once('spawn', () => {
				if (other.pid === undefined) reject(new Error('no pid'));
				else resolve(other.pid);
			});
			other.once('error', reject);
		});
		// A port nothing listens on any more.
		const closed = createServer();
		const port = await new Promise<number>((resolve) => {
			closed.listen(0, '127.0.0.1', () => {
				const address = closed.address();
				resolve(typeof address === 'object' && address !== null ? address.port : 0);
			});
		});
		await new Promise((resolve) => closed.close(resolve));
		await writeFile(
			join(data, 'daemon.lock'),
			JSON.stringify({ port, pid, token: 'a'.repeat(64), version: 'gone', startedAt: 1 })
		);

		const stopped = await run(['stop', '--data-directory', data], data, who);
		expect(stopped.code).toBe(0);
		expect(stopped.stdout).toMatch(/^diff delver was not running\./);
		expect(stopped.stdout).toContain('nothing else was touched');
		expect(await readLockfile(data)).toEqual({ kind: 'none' });
		expect(processExists(value(parseProcessId(pid)))).toBe(true);
		expect(other.exitCode).toBeNull();
		expect(other.signalCode).toBeNull();
	});

	it('replaces a running daemon of another version, and says so', async () => {
		const repo = await useFixture(edited);
		const { who, data } = await setUp();
		const old = await testDaemon({ dataDirectory: data, version: version('0.0.0+older'), who });
		const result = await run(['--no-open', '--data-directory', data], repo.dir, who);
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(
			/^A different version of diff delver was running; this version has replaced it\./
		);
		await old.stopped;
		const lock = await readLockfile(data);
		if (lock.kind !== 'lock') throw new Error('no lock');
		expect(lock.lock.version).not.toBe('0.0.0+older');
		expect(lock.lock.port).not.toBe(old.port);
		const token = value(parseDaemonToken(lock.lock.token));
		expect(
			value(
				await clientOf({ origin: `http://127.0.0.1:${String(lock.lock.port)}`, token }).listDiffs()
			).diffs
		).toHaveLength(1);
	});

	it('stops a running daemon of any other version on diff-delver stop, newer ones included', async () => {
		const { who, data } = await setUp();
		const newer = await testDaemon({
			dataDirectory: data,
			version: version('999.0.0+aaaaaaaaaaaa'),
			who
		});
		const result = await run(['stop', '--data-directory', data], data, who);
		expect(result).toEqual({ code: 0, stdout: 'diff delver has stopped.\n', stderr: '' });
		await newer.stopped;
		expect(await readLockfile(data)).toEqual({ kind: 'none' });
	});

	it('prints its help and version, and says what is wrong with a command it cannot read', async () => {
		const who = await reviewer();
		const repo = await emptyRepo();
		const help = await run(['--help'], repo.dir, who);
		expect(help).toEqual({ code: 0, stdout: `${HELP_TEXT}\n`, stderr: '' });
		const shown = await run(['--version'], repo.dir, who);
		expect(shown.stdout).toMatch(/^diff-delver 0\.0\.1-dev\+[0-9a-f]{12}\n$/);
		const wrong = await run(['frobnicate'], repo.dir, who);
		expect(wrong.code).toBe(2);
		expect(wrong.stderr).toMatch(/^diff delver has no command "frobnicate"/);
		const extra = await run(['choose', 'main'], repo.dir, who);
		expect(extra.code).toBe(2);
		expect(extra.stderr).toMatch(/^diff-delver choose did not expect "main" after it/);
	});
});
