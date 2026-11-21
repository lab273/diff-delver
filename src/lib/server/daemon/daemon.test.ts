import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeApiError } from '#lib/api/client.ts';
import { parseAbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { tokenCookieName } from '#lib/core/daemon/request-gate.ts';
import {
	defineFixture,
	emptyRepo,
	tempDirectory,
	useFixture
} from '../../../../tests/support/fixture-repos.ts';
import {
	clientOf,
	rawRequest,
	testDaemon,
	tryStartDaemon,
	version
} from '../../../../tests/support/daemons.ts';
import { listingsAround } from '../../../../tests/support/directory-listing.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { parseGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { startOutcome, startPage } from '../cli/outcome.ts';
import { describeDaemonStartError, TIDY_STORES_EVERY_MS } from './daemon.ts';
import { settableClock } from '#lib/core/clock.ts';
import { randomIds } from '#lib/server/system.ts';
import { listSnapshots, listStores } from '#lib/server/store/index.ts';
import { snapshotGitSource } from '#lib/server/sources/git/index.ts';
import { located } from '../../../../tests/support/git-source-helpers.ts';
import { at } from '../../../../tests/support/report-rows.ts';
import { reviewer } from '../../../../tests/support/reviewer-git.ts';
import { lockfilePath, readLockfile } from './lockfile.ts';

/** A committed file, edited, and a new one: uncommitted changes to open. */
const edited = defineFixture('daemon-edited', async (repo) => {
	await repo.write('src/a.ts', 'export const a = 1;\n');
	await repo.write('package-lock.json', '{}\n');
	await repo.commit('base');
	await repo.write('src/a.ts', 'export const a = 2;\n');
	await repo.write('src/b.ts', 'export const b = 1;\n');
	await repo.write('package-lock.json', '{ "lockfileVersion": 3 }\n');
});

describe('the daemon', () => {
	it('opens, lists, loads, closes, reopens and deletes diffs through the typed client', async () => {
		const repo = await useFixture(edited);
		const daemon = await testDaemon();
		const client = clientOf(daemon);

		const started = value(await client.start({ directory: repo.dir }));
		expect(started).toMatchObject({
			kind: 'opened',
			resumed: false,
			diff: {
				id: 'r_1',
				title: 'Uncommitted changes',
				state: { kind: 'open' },
				size: { files: 3, added: 3, removed: 2 },
				sizeText: '3 files changed, 3 lines added and 2 removed',
				progressText: 'Not started: 3 changes to review'
			}
		});
		expect(value(await client.start({ directory: repo.dir }))).toMatchObject({
			kind: 'opened',
			resumed: true,
			update: null
		});

		const listed = value(await client.listDiffs());
		expect(listed.diffs).toHaveLength(1);
		expect(listed.diffs[0]).toMatchObject({ kind: 'diff', id: 'r_1' });

		const page = value(
			await client.loadDiff(started.kind === 'opened' ? started.diff.id : never())
		);
		expect(page.directory).toBe(repo.dir);
		expect(page.sorted).toBe(false);
		expect(page.groups.map((g) => [g.key.kind, g.parts.map((p) => p.path)])).toEqual([
			['uncategorised', ['src/a.ts', 'src/b.ts']],
			['ignored', ['package-lock.json']]
		]);
		expect(page.groups[1]?.parts[0]?.ignored).toEqual([{ kind: 'stated', text: 'Lockfile' }]);

		const id = page.summary.id;
		expect(value(await client.checkForChanges(id))).toEqual({ kind: 'unchanged' });
		expect(value(await client.closeDiff(id)).diff.state).toEqual({
			kind: 'closed',
			reason: 'You closed this diff.'
		});
		expect(value(await client.checkForChanges(id))).toEqual({ kind: 'closed' });
		expect(value(await client.reopenDiff(id)).diff.state).toEqual({ kind: 'open' });
		expect(value(await client.deleteDiff(id))).toEqual({ problem: null });
		expect(value(await client.listDiffs()).diffs).toEqual([]);

		const gone = await client.loadDiff(id);
		expect(gone.ok).toBe(false);
		if (!gone.ok) {
			expect(gone.error).toMatchObject({ kind: 'refused', status: 404, reason: 'ReportNotFound' });
			expect(describeApiError(gone.error)).toMatch(/This diff is not in diff delver any more/);
		}
		expect(value(await client.daemonInfo())).toEqual({ version: 'test', pid: process.pid });
	});

	it('says why in plain words when a folder is not a repository, and when there is nothing to review', async () => {
		const daemon = await testDaemon();
		const client = clientOf(daemon);
		const folder = await tempDirectory();
		const notRepo = await client.start({ directory: folder });
		expect(notRepo).toMatchObject({ ok: false, error: { status: 422, reason: 'NotARepository' } });
		if (!notRepo.ok) expect(describeApiError(notRepo.error)).toMatch(/is not a git repository/);

		const repo = await emptyRepo();
		await repo.write('a.txt', 'a\n');
		await repo.commit('only');
		const staged = value(await client.open({ directory: repo.dir, source: 'staged' }));
		expect(staged.kind).toBe('nothing');
		if (staged.kind === 'nothing') expect(staged.reason).toMatch(/^Nothing is staged/);
		const suggested = value(await client.suggest(repo.dir));
		expect(suggested.suggestion).toMatchObject({
			kind: 'nothing',
			candidates: [{ source: 'HEAD', description: 'The last commit (1 file)' }]
		});
		// A source that cannot be opened: the start page is told why, in plain words.
		const mistyped = value(await client.suggest(repo.dir, 'mian...HEAD'));
		expect(mistyped.asked?.problem).toMatch(/mian/);
		expect(value(await client.suggest(repo.dir, 'staged')).asked).toEqual({
			problem: null,
			changes: false
		});
		expect(value(await client.suggest(repo.dir)).asked).toBeNull();
		const badSource = await client.open({ directory: repo.dir, source: '-x' });
		expect(badSource).toMatchObject({ ok: false, error: { status: 422 } });
	});

	it('says on the start page why what it suggested could not be opened, as the command does', async () => {
		const repo = await useFixture(edited);
		const data = await tempDirectory();
		const daemon = await testDaemon({ dataDirectory: data });
		const client = clientOf(daemon);
		// Where the saved copies of repositories go is a file: nothing can be opened.
		await rm(join(data, 'stores'), { recursive: true, force: true });
		await writeFile(join(data, 'stores'), 'not a folder\n');
		const outcome = await startOutcome(client, repo.dir);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.page).toBe(startPage(repo.dir, value(parseGitSourceSpec('working-tree'))));
		const [problem] = outcome.lines;
		expect(problem).toMatch(/data folder/);
		const page = value(await client.suggest(repo.dir, 'working-tree'));
		expect(page.asked).toEqual({ problem, changes: false });
		// Once the folder is mended, the page is told it can be opened now.
		await rm(join(data, 'stores'));
		expect(value(await client.suggest(repo.dir, 'working-tree')).asked).toEqual({
			problem: null,
			changes: true
		});
	});

	it('never writes to the repository it reads', async () => {
		const repo = await useFixture(edited);
		const daemon = await testDaemon();
		const client = clientOf(daemon);
		const { before, after } = await listingsAround([repo.dir], async () => {
			const started = value(await client.start({ directory: repo.dir }));
			const id = started.kind === 'opened' ? started.diff.id : never();
			value(await client.suggest(repo.dir));
			value(await client.open({ directory: repo.dir, source: 'staged' }));
			value(await client.loadDiff(id));
			value(await client.checkForChanges(id));
		});
		expect(after).toEqual(before);
	});
});

describe('the daemon’s gate', () => {
	it('lets the browser in once with an entry code in the address, and takes it out of the address', async () => {
		const daemon = await testDaemon();
		const code = daemon.entryCode();
		const entered = await rawRequest(daemon.port, { path: `/?entry=${code}` });
		expect(entered.status).toBe(303);
		expect(entered.headers['location']).toBe('/');
		expect(entered.headers['set-cookie']).toEqual([
			`${tokenCookieName(daemon.port)}=${daemon.token}; Path=/; HttpOnly; SameSite=Strict`
		]);
		expect(entered.headers['referrer-policy']).toBe('no-referrer');

		const cookie = `${tokenCookieName(daemon.port)}=${daemon.token}`;
		const home = await rawRequest(daemon.port, { path: '/', headers: { cookie } });
		expect(home.status).toBe(200);
		expect(home.body).toContain('There are no diffs in diff delver.');
		expect(home.headers['referrer-policy']).toBe('no-referrer');
		// The pages load nothing from anywhere but the daemon, and run only its own scripts.
		const policy = String(home.headers['content-security-policy']);
		expect(policy).toContain("default-src 'self'");
		expect(policy).toMatch(/script-src 'self' 'nonce-[^']+'/);
		expect(policy).toContain("object-src 'none'");
		expect(policy).toContain("frame-ancestors 'none'");
		expect(policy).not.toMatch(/script-src[^;]*unsafe/);

		// The same address again, as from another browser, is out of date.
		const again = await rawRequest(daemon.port, { path: `/?entry=${code}` });
		expect(again.status).toBe(403);
		expect(again.body).toContain('This link is out of date');
		expect(again.body).toContain('opens it once, within two minutes');
		// The token itself never lets a browser in from the address.
		const token = await rawRequest(daemon.port, { path: `/?token=${daemon.token}` });
		expect(token.status).toBe(403);
		expect(token.headers['set-cookie']).toBeUndefined();
	});

	it('gives the command an entry code, and only with its token', async () => {
		const daemon = await testDaemon();
		const given = value(await clientOf(daemon).entryCode());
		expect(given.code).toMatch(/^[0-9a-f]{32}$/);
		const entered = await rawRequest(daemon.port, { path: `/diffs/r_9?entry=${given.code}` });
		expect(entered.status).toBe(303);
		expect(entered.headers['location']).toBe('/diffs/r_9');
		const refused = await rawRequest(daemon.port, { method: 'POST', path: '/api/entry' });
		expect(refused.status).toBe(403);
	});

	it('answers a request without the token with a page saying how to open diff delver', async () => {
		const daemon = await testDaemon();
		const page = await rawRequest(daemon.port, { path: '/' });
		expect(page.status).toBe(403);
		expect(page.headers['content-type']).toMatch(/text\/html/);
		expect(page.body).toContain('Open diff delver from your terminal');
		expect(page.body).toContain('<code>diff-delver</code>');
		expect(page.headers['content-security-policy']).toBe(
			"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
		);

		const old = await rawRequest(daemon.port, { path: `/?entry=${'0'.repeat(32)}` });
		expect(old.status).toBe(403);
		expect(old.body).toContain('This link is out of date');

		const api = await rawRequest(daemon.port, { path: '/api/diffs' });
		expect(api.status).toBe(403);
		expect(JSON.parse(api.body)).toMatchObject({ error: { kind: 'Refused' } });
	});

	it('answers only to its own host name', async () => {
		const daemon = await testDaemon();
		const cookie = `${tokenCookieName(daemon.port)}=${daemon.token}`;
		const rebound = await rawRequest(daemon.port, {
			path: '/',
			headers: { host: `evil.example:${String(daemon.port)}`, cookie }
		});
		expect(rebound.status).toBe(421);
		expect(rebound.body).toContain('Open diff delver by its own address');
	});

	it('makes changes asked for with the cookie only from its own pages', async () => {
		const repo = await useFixture(edited);
		const daemon = await testDaemon();
		const cookie = `${tokenCookieName(daemon.port)}=${daemon.token}`;
		const post = (origin?: string) =>
			rawRequest(daemon.port, {
				method: 'POST',
				path: '/api/start',
				headers: {
					cookie,
					'content-type': 'application/json',
					...(origin === undefined ? {} : { origin })
				},
				body: JSON.stringify({ directory: repo.dir })
			});
		expect((await post()).status).toBe(403);
		expect((await post('http://evil.example')).status).toBe(403);
		expect(value(await clientOf(daemon).listDiffs()).diffs).toEqual([]);
		expect((await post(daemon.origin)).status).toBe(200);
		expect(value(await clientOf(daemon).listDiffs()).diffs).toHaveLength(1);
	});
});

describe('the daemon’s lock', () => {
	it('records where it is, and stops cleanly: the lock goes, the port closes, the database is let go', async () => {
		const dataDirectory = await tempDirectory();
		const daemon = await testDaemon({ dataDirectory });
		const lock = await readLockfile(dataDirectory);
		expect(lock).toMatchObject({
			kind: 'lock',
			lock: { port: daemon.port, pid: process.pid, token: daemon.token, version: 'test' }
		});
		await daemon.stop();
		await daemon.stopped;
		expect(await readLockfile(dataDirectory)).toEqual({ kind: 'none' });
		await expect(fetch(`${daemon.origin}/`)).rejects.toThrow();
		// The database is closed, so another daemon can open the folder at once.
		const next = await testDaemon({ dataDirectory });
		expect(next.port).not.toBe(daemon.port);
	});

	it('stops itself when its lockfile is gone or holds another daemon’s entry, and not before', async () => {
		const checks: (() => Promise<void>)[] = [];
		/** Runs the daemons' checks now, and says whether this one has stopped since. */
		const checked = async (daemon: { readonly stopped: Promise<void> }): Promise<boolean> => {
			let stopped = false;
			void daemon.stopped.then(() => {
				stopped = true;
			});
			await Promise.all(checks.map((check) => check()));
			await Promise.resolve();
			return stopped;
		};
		const repeat = (check: () => Promise<void>): (() => void) => {
			checks.push(check);
			return () => {
				checks.splice(checks.indexOf(check), 1);
			};
		};

		const dataDirectory = await tempDirectory();
		const daemon = await testDaemon({ dataDirectory, repeat });
		expect(await checked(daemon)).toBe(false);
		await rm(dataDirectory, { recursive: true, force: true });
		expect(await checked(daemon)).toBe(true);
		await expect(fetch(`${daemon.origin}/`)).rejects.toThrow();
		expect(checks).toEqual([]);

		const other = await tempDirectory();
		const replaced = await testDaemon({ dataDirectory: other, repeat });
		const text = await readFile(lockfilePath(other), 'utf8');
		await writeFile(lockfilePath(other), text.replace(/"port":\d+/, '"port":9'));
		expect(await checked(replaced)).toBe(true);
	});

	it('refuses to start a second daemon for a data folder that has one', async () => {
		const dataDirectory = await tempDirectory();
		const first = await testDaemon({ dataDirectory });
		const second = await tryStartDaemon({ dataDirectory, version: version('other') });
		expect(second).toMatchObject({
			ok: false,
			error: { kind: 'AlreadyRunning', lock: { port: first.port } }
		});
		expect(await readLockfile(dataDirectory)).toMatchObject({ lock: { port: first.port } });
	});

	it('replaces a stale lockfile, whose daemon is gone, and one that cannot be read', async () => {
		const dataDirectory = await tempDirectory();
		const stopped = await testDaemon({ dataDirectory });
		const text = await readFile(lockfilePath(dataDirectory), 'utf8');
		await stopped.stop();
		// As a daemon that was killed leaves it: its port answers no more.
		await writeFile(lockfilePath(dataDirectory), text);
		const next = await testDaemon({ dataDirectory });
		expect(await readLockfile(dataDirectory)).toMatchObject({ lock: { port: next.port } });
		await next.stop();

		await writeFile(lockfilePath(dataDirectory), '{"port": 1, "half written');
		const after = await testDaemon({ dataDirectory });
		expect(await readLockfile(dataDirectory)).toMatchObject({ lock: { port: after.port } });
	});

	it('says plainly when the data folder cannot be written', async () => {
		const file = join(await tempDirectory(), 'a-file');
		await writeFile(file, 'not a folder');
		const started = await tryStartDaemon({ dataDirectory: value(parseAbsolutePath(file)) });
		expect(started.ok).toBe(false);
		if (!started.ok) {
			expect(describeDaemonStartError(started.error)).toMatch(
				/diff delver could not open its database/
			);
		}
	});
});

function never(): never {
	throw new Error('unreachable');
}

describe('the daemon’s tidying', () => {
	it('removes snapshots left behind, by its clock, while it runs', async () => {
		const repo = await useFixture(edited);
		const who = await reviewer();
		const dataDirectory = await tempDirectory();
		// A snapshot taken by a run that crashed before recording its revision.
		value(
			await snapshotGitSource(
				dataDirectory,
				await located(repo.dir, who),
				value(parseGitSourceSpec('HEAD')),
				randomIds.snapshotId()
			)
		);
		const snapshots = async (): Promise<number> => {
			let count = 0;
			for (const store of value(await listStores(dataDirectory))) {
				count += value(await listSnapshots(store)).length;
			}
			return count;
		};
		const checks: (() => Promise<void>)[] = [];
		const repeat = (check: () => Promise<void>): (() => void) => {
			checks.push(check);
			return () => {
				checks.splice(checks.indexOf(check), 1);
			};
		};
		const clock = settableClock(at(Date.UTC(2026, 0, 15, 9, 30)));
		const daemon = await testDaemon({ dataDirectory, repeat, clock, who });
		await daemon.cleaned;
		const run = () => Promise.all(checks.map((check) => check()));
		await run();
		// Seen at start, but not yet left alone for the store's grace period.
		expect(await snapshots()).toBe(1);
		clock.advance(TIDY_STORES_EVERY_MS + 1);
		await run();
		expect(await snapshots()).toBe(0);
	});
});
