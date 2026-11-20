import { readFile, writeFile } from 'node:fs/promises';
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
import { describeDaemonStartError } from './daemon.ts';
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
			changed: false
		});

		const listed = value(await client.listDiffs());
		expect(listed.diffs).toHaveLength(1);
		expect(listed.diffs[0]).toMatchObject({ kind: 'diff', id: 'r_1' });

		const page = value(
			await client.loadDiff(started.kind === 'opened' ? started.diff.id : never())
		);
		expect(page.directory).toBe(repo.dir);
		expect(page.sorted).toBe(false);
		expect(page.groups.map((g) => [g.group.kind, g.files.map((f) => f.path)])).toEqual([
			['ignored', ['package-lock.json']],
			['uncategorised', ['src/a.ts', 'src/b.ts']]
		]);
		expect(page.groups[0]?.files[0]?.ignored).toEqual([{ kind: 'stated', text: 'Lockfile' }]);

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
		const badSource = await client.open({ directory: repo.dir, source: '-x' });
		expect(badSource).toMatchObject({ ok: false, error: { status: 422 } });
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
	it('lets the browser in with the token in the address, and takes it out of the address', async () => {
		const daemon = await testDaemon();
		const entered = await rawRequest(daemon.port, { path: `/?token=${daemon.token}` });
		expect(entered.status).toBe(303);
		expect(entered.headers['location']).toBe('/');
		expect(entered.headers['set-cookie']).toEqual([
			`${tokenCookieName(daemon.port)}=${daemon.token}; Path=/; HttpOnly; SameSite=Strict`
		]);
		expect(entered.headers['referrer-policy']).toBe('no-referrer');

		const cookie = `${tokenCookieName(daemon.port)}=${daemon.token}`;
		const home = await rawRequest(daemon.port, { path: '/', headers: { cookie } });
		expect(home.status).toBe(200);
		expect(home.body).toContain('No diffs have been opened yet.');
		expect(home.headers['referrer-policy']).toBe('no-referrer');
	});

	it('answers a request without the token with a page saying how to open diff delver', async () => {
		const daemon = await testDaemon();
		const page = await rawRequest(daemon.port, { path: '/' });
		expect(page.status).toBe(403);
		expect(page.headers['content-type']).toMatch(/text\/html/);
		expect(page.body).toContain('Open diff delver from your terminal');
		expect(page.body).toContain('<code>diff-delver</code>');

		const old = await rawRequest(daemon.port, { path: `/?token=${'0'.repeat(64)}` });
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
