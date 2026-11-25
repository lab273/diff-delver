import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { describeApiError } from '#lib/api/client.ts';
import { lineNumberOf } from '#lib/core/line-number.tiny.ts';
import { escapedRepoPath } from '#lib/core/path-bytes.ts';
import { parseRepoPath } from '#lib/core/repo-path.tiny.ts';
import { parseReportId } from '#lib/core/report-id.tiny.ts';
import { mcpOverHttp } from '../../../../tests/support/mcp-client.ts';
import { parseAbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import {
	defineFixture,
	emptyRepo,
	tempDirectory,
	useFixture
} from '../../../../tests/support/fixture-repos.ts';
import {
	browserClient,
	browserCookie,
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
import { BROWSER_ACCESS_FILE } from './browser-access.ts';
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

/** A PNG's first bytes, then `size` more: binary, as git sees a NUL in it. */
function png(size: number): Uint8Array {
	const bytes = new Uint8Array(8 + size);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	return bytes;
}

const testsAndPictures = defineFixture('daemon-tests-and-pictures', async (repo) => {
	await repo.write('src/a.ts', 'export const a = 1;\n');
	await repo.write('src/a.test.ts', 'test(a);\n');
	await repo.write('logo.png', png(100));
	await repo.write('old.png', png(40));
	await repo.commit('base');
	await repo.write('src/a.ts', 'export const a = 2;\n');
	await repo.write('src/a.test.ts', 'test(a);\ntest(a, 2);\ntest(a, 3);\n');
	await repo.write('logo.png', png(1_000));
	await repo.write('icon.png', png(2_040));
	await repo.remove('old.png');
});

describe('the daemon', () => {
	it('counts tests and binary files alike in the command, the list and the page, after an agent and an update too', async () => {
		const repo = await useFixture(testsAndPictures);
		const daemon = await testDaemon();
		const client = clientOf(daemon);
		const name = basename(repo.dir);
		const outcome = await startOutcome(client, repo.dir);
		expect(outcome.lines[0]).toBe(
			`Uncommitted changes in ${name}: 5 files changed, 1 line added and 1 removed, plus 2 added in tests; 3 binary files: 1 added (2 KB), 1 removed (48 bytes), 1 changed (108 bytes to 1,008 bytes).`
		);
		const id = outcome.page.split('/').at(-1) ?? '';
		const agrees = async (size: unknown, sizeText: string): Promise<void> => {
			const listed = value(await client.listDiffs()).diffs.find((d) => d.kind === 'diff');
			const page = value(await client.loadDiff(value(parseReportId(id))));
			for (const summary of [listed, page.summary]) {
				expect(summary).toMatchObject({
					size,
					sizeText,
					binaryText:
						'3 binary files: 1 added (2 KB), 1 removed (48 bytes), 1 changed (108 bytes to 1,008 bytes)'
				});
			}
		};
		await agrees(
			{ files: 5, added: 3, removed: 1, tests: { added: 2, removed: 0 } },
			'5 files changed, 1 line added and 1 removed, plus 2 added in tests'
		);

		// An agent says src/a.ts is a test too, and the counts follow it everywhere.
		const session = await mcpOverHttp({
			origin: daemon.origin,
			token: daemon.mcpToken,
			directory: repo.dir
		});
		onTestFinished(() => session.close());
		const assigned = await session.call('assign', {
			report: id,
			version: 1,
			items: [{ file: 'src/a.ts', role: 'test' }]
		});
		expect(assigned.refused).toBe(false);
		await agrees(
			{ files: 5, added: 3, removed: 1, tests: { added: 3, removed: 1 } },
			'5 files changed, 3 lines added and 1 removed, all in tests'
		);

		// An update keeps the agent's role on the lines it carries over.
		await repo.write('src/a.test.ts', 'test(a);\ntest(a, 2);\ntest(a, 3);\ntest(a, 4);\n');
		const updated = await startOutcome(client, repo.dir);
		expect(updated.page).toBe(outcome.page);
		await agrees(
			{ files: 5, added: 4, removed: 1, tests: { added: 4, removed: 1 } },
			'5 files changed, 4 lines added and 1 removed, all in tests'
		);
	});

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
		expect(listed.diffs[0]).toMatchObject({ kind: 'diff', id: 'r_1', directory: repo.dir });

		const page = value(
			await client.loadDiff(started.kind === 'opened' ? started.diff.id : never())
		);
		expect(page.summary.directory).toBe(repo.dir);
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
			reason: 'You closed this Delve.'
		});
		expect(value(await client.checkForChanges(id))).toEqual({ kind: 'closed' });
		expect(value(await client.reopenDiff(id)).diff.state).toEqual({ kind: 'open' });
		const browser = await browserClient(daemon);
		expect(value(await browser.deleteDiff(id))).toEqual({ problem: null });
		expect(value(await client.listDiffs()).diffs).toEqual([]);

		const gone = await client.loadDiff(id);
		expect(gone.ok).toBe(false);
		if (!gone.ok) {
			expect(gone.error).toMatchObject({ kind: 'refused', status: 404, reason: 'ReportNotFound' });
			expect(describeApiError(gone.error)).toMatch(/This Delve is not in diff delver any more/);
		}
		expect(value(await client.daemonInfo())).toEqual({ version: 'test', pid: process.pid });
	});

	it('lists the repositories of its diffs, each once, and says when a folder is gone', async () => {
		const first = await useFixture(edited);
		const second = await useFixture(edited);
		const daemon = await testDaemon();
		const client = clientOf(daemon);
		value(await client.start({ directory: first.dir }));
		value(await client.start({ directory: second.dir }));
		value(await client.open({ directory: first.dir, source: 'HEAD' }));

		// Most recently active first, and the repository with two diffs once.
		expect(value(await client.listDiffs()).repositories).toEqual([
			{
				repository: basename(first.dir),
				directory: first.dir,
				sameName: false,
				there: true
			},
			{
				repository: basename(second.dir),
				directory: second.dir,
				sameName: false,
				there: true
			}
		]);

		await rm(second.dir, { recursive: true });
		const listed = value(await client.listDiffs());
		expect(listed.diffs).toHaveLength(3);
		expect(listed.repositories.map((r) => [r.directory, r.there])).toEqual([
			[first.dir, true],
			[second.dir, false]
		]);
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
		const session = entered.headers['set-cookie']?.[0];
		expect(session).toMatch(
			new RegExp(`^${daemon.reviewCookie}=[a-f0-9]{64}; Path=/; HttpOnly; SameSite=Strict$`)
		);
		expect(session).not.toContain(daemon.token);
		expect(entered.headers['referrer-policy']).toBe('no-referrer');

		const cookie = session?.split(';', 1)[0] ?? '';
		const home = await rawRequest(daemon.port, { path: '/', headers: { cookie } });
		expect(home.status).toBe(200);
		expect(home.body).toContain('No Delves yet.');
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
		expect(again.body).toContain('opens it once, and this one has been used already');
		// The token itself never lets a browser in from the address.
		const token = await rawRequest(daemon.port, { path: `/?token=${daemon.token}` });
		expect(token.status).toBe(403);
		expect(token.headers['set-cookie']).toBeUndefined();
	});

	it('keeps a browser’s review access through a restart, and nothing else it gave out', async () => {
		const dataDirectory = await tempDirectory();
		const repo = await useFixture(edited);
		const first = await testDaemon({ dataDirectory });
		const command = clientOf(first);
		const opened = value(await command.start({ directory: repo.dir }));
		if (opened.kind !== 'opened') throw new Error(opened.kind);
		const id = opened.diff.id;
		const browser = await browserClient(first);
		const saved = value(
			await browser.addDraftComment(id, {
				version: opened.diff.version,
				anchor: {
					path: escapedRepoPath(value(parseRepoPath('src/a.ts'))),
					side: 'new',
					first: lineNumberOf(1),
					last: lineNumberOf(1)
				},
				body: 'Keep this draft through a restart.'
			})
		);
		const cookie = await browserCookie(first);
		const unused = value(await command.entryCode()).code;
		// Only the person may read what is kept, as with the lockfile beside it.
		const kept = join(dataDirectory, BROWSER_ACCESS_FILE);
		expect((await stat(kept)).mode & 0o777).toBe(0o600);
		expect(await readFile(kept, 'utf8')).toContain(cookie.split('=', 2)[1] ?? 'none');
		await first.stop();
		expect((await stat(kept)).mode & 0o777).toBe(0o600);

		const second = await testDaemon({ dataDirectory });
		const delve = `/diffs/${id}`;
		const comments = `/api/diffs/${id}/comments`;
		// The same browser may still read and write the drafts, with no new link.
		expect(second.reviewCookie).toBe(first.reviewCookie);
		expect((await rawRequest(second.port, { path: delve, headers: { cookie } })).status).toBe(200);
		const stored = await rawRequest(second.port, { path: comments, headers: { cookie } });
		expect(stored.status).toBe(200);
		expect(JSON.parse(stored.body)).toMatchObject({
			comments: [JSON.parse(JSON.stringify(saved))]
		});
		// A link, and the command's own credential, are one daemon's and end with it.
		expect((await rawRequest(second.port, { path: `${delve}?entry=${unused}` })).status).toBe(403);
		expect(
			(
				await rawRequest(second.port, {
					path: '/api/daemon',
					headers: { authorization: `Bearer ${first.token}` }
				})
			).status
		).toBe(403);
		expect(second.token).not.toBe(first.token);
		expect(second.mcpToken).not.toBe(first.mcpToken);
	});

	it('keeps two data folders’ browsers apart, and forgets a browser once started again without its file', async () => {
		const dataDirectory = await tempDirectory();
		const first = await testDaemon({ dataDirectory });
		const other = await testDaemon();
		const cookie = await browserCookie(first);
		// Cookies go to every port of the host: another folder's daemon must not take this one's.
		expect(other.reviewCookie).not.toBe(first.reviewCookie);
		expect((await rawRequest(other.port, { path: '/', headers: { cookie } })).status).toBe(403);
		const renamed = `${other.reviewCookie}=${cookie.split('=', 2)[1] ?? ''}`;
		expect((await rawRequest(other.port, { path: '/', headers: { cookie: renamed } })).status).toBe(
			403
		);
		// A running daemon read the file when it started: deleting it now changes nothing yet.
		await rm(join(dataDirectory, BROWSER_ACCESS_FILE));
		expect((await rawRequest(first.port, { path: '/', headers: { cookie } })).status).toBe(200);
		await first.stop();

		// Stopped, with the file gone, and started again: every browser has lost review access.
		const second = await testDaemon({ dataDirectory });
		expect((await rawRequest(second.port, { path: '/', headers: { cookie } })).status).toBe(403);
		const again = `${second.reviewCookie}=${cookie.split('=', 2)[1] ?? ''}`;
		expect((await rawRequest(second.port, { path: '/', headers: { cookie: again } })).status).toBe(
			403
		);
		expect((await rawRequest(second.port, { path: `/?entry=${second.entryCode()}` })).status).toBe(
			303
		);
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
		const cookie = await browserCookie(daemon);
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
		const cookie = await browserCookie(daemon);
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
