/**
 * The viewer's routes against a real daemon, through the typed client: the
 * page's frame, one part's lines, unchanged lines to open, and marking reviewed
 * on the version shown, refused once the diff was updated.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { NO_EDITS } from '#lib/core/edit-count.tiny.ts';
import { ApiClient, describeApiError } from '#lib/api/client.ts';
import type { AddDraftComment, DiffPage, DraftCommentView, PartQuery } from '#lib/api/schemas.ts';
import { escapedRepoPath } from '#lib/core/path-bytes.ts';
import { parseRepoPath } from '#lib/core/repo-path.tiny.ts';
import { parseRevisionNumber, type RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { parseDraftCommentId, type DraftCommentId } from '#lib/core/draft-comment-id.tiny.ts';
import { lineNumberOf } from '#lib/core/line-number.tiny.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { settableClock } from '#lib/core/clock.ts';
import { parseTimestamp } from '#lib/core/timestamp.tiny.ts';
import { parseSectionId } from '#lib/core/section-id.tiny.ts';
import { parseSearchText } from '#lib/core/search/search-text.tiny.ts';
import { ReportService } from '#lib/server/reports/index.ts';
import { viewCookieName } from '#lib/core/daemon/request-gate.ts';
import { parseReportId } from '#lib/core/report-id.tiny.ts';
import { ApiErrorBodySchema } from '#lib/api/schemas.ts';
import {
	browserClient,
	browserCookie,
	clientOf,
	rawRequest,
	testDaemon
} from '../../../../tests/support/daemons.ts';
import {
	defineFixture,
	tempDirectory,
	useFixture
} from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { mcpOverHttp, reportIn } from '../../../../tests/support/mcp-client.ts';

const numbered = (from: number, to: number): string =>
	Array.from({ length: to - from + 1 }, (_, i) => `line ${String(from + i)}\n`).join('');

/** A long file edited in two places, a new file, a binary one and a lockfile, uncommitted. */
const viewed = defineFixture('viewer-routes', async (repo) => {
	await repo.write('src/long.ts', numbered(1, 60));
	await repo.write('logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
	await repo.write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
	await repo.commit('base');
	await repo.write(
		'src/long.ts',
		numbered(1, 9) + 'line ten\n' + numbered(11, 49) + numbered(51, 60)
	);
	await repo.write('src/new.ts', 'export const n = 1;\n');
	await repo.write('logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9, 9, 9]));
	await repo.write('pnpm-lock.yaml', 'lockfileVersion: 10\n');
});

function commentId(n: number): DraftCommentId {
	return value(parseDraftCommentId(n));
}

function at(time: number) {
	return value(parseTimestamp(time));
}

function revision(n: number): RevisionNumber {
	return value(parseRevisionNumber(n));
}

function path(text: string) {
	return escapedRepoPath(value(parseRepoPath(text)));
}

describe('the viewer’s routes', () => {
	it('give the frame, a part’s lines and the lines between its hunks, of the version shown', async () => {
		const repo = await useFixture(viewed);
		const daemon = await testDaemon();
		const client = clientOf(daemon);
		const started = value(await client.start({ directory: repo.dir }));
		if (started.kind !== 'opened') throw new Error(started.kind);
		const id = started.diff.id;

		const page = value(await client.loadDiff(id));
		expect(page.view).toBe('sections');
		expect(page.overview).toBeNull();
		expect(page.groups.every((group) => group.summary === null)).toBe(true);
		expect(
			page.groups.map((g) => [g.key.kind, g.parts.map((p) => [p.path, p.change, p.tally.units])])
		).toEqual([
			[
				'uncategorised',
				[
					['logo.png', 'changed, binary file', 1],
					['src/long.ts', 'changed', 3],
					['src/new.ts', 'added', 1]
				]
			],
			['ignored', [['pnpm-lock.yaml', 'changed', 2]]]
		]);
		expect(page.files.map((f) => [f.path, f.tally.units, f.ignored])).toEqual([
			['logo.png', 1, 0],
			['pnpm-lock.yaml', 0, 2],
			['src/long.ts', 3, 0],
			['src/new.ts', 1, 0]
		]);
		// The counts agree with the summary's, which the list and the command show.
		expect(page.summary.progress.counted).toBe(5);

		const part = (p: string): PartQuery => ({
			version: revision(1),
			assignments: page.assignments,
			view: 'sections',
			group: { kind: 'uncategorised' },
			path: path(p)
		});
		const long = value(await client.readPart(id, part('src/long.ts')));
		expect(long.sizes).toBeNull();
		expect(
			long.blocks.map((b) => (b.kind === 'hidden' ? `${b.new.first}-${b.new.last}` : b.kind))
		).toEqual(['1-6', 'hunk', '14-46', 'hunk', '53-59']);
		const hidden = long.blocks[2];
		if (hidden?.kind !== 'hidden') throw new Error('hidden');
		const lines = value(
			await client.readLines(id, {
				version: revision(1),
				side: 'new',
				path: path('src/long.ts'),
				first: hidden.new.first,
				last: lineNumberOf(16)
			})
		);
		expect(lines).toEqual({
			lines: [
				{ number: 14, text: 'line 14' },
				{ number: 15, text: 'line 15' },
				{ number: 16, text: 'line 16' }
			],
			lineCount: 59
		});
		const logo = value(await client.readPart(id, part('logo.png')));
		expect(logo).toEqual({ blocks: [], sizes: { old: 8, new: 10 }, image: null });

		// A part the version does not have, and lines asked for wrongly, are refused in plain words.
		const missing = await client.readPart(id, {
			...part('src/new.ts'),
			group: { kind: 'ignored' }
		});
		expect(missing).toMatchObject({ ok: false, error: { status: 404, reason: 'PartNotFound' } });
		if (!missing.ok) expect(describeApiError(missing.error)).toMatch(/Reload the page/);
		const binary = await client.readLines(id, {
			version: revision(1),
			side: 'new',
			path: path('logo.png'),
			first: lineNumberOf(1),
			last: lineNumberOf(2)
		});
		expect(binary).toMatchObject({ ok: false, error: { status: 422, reason: 'FileIsBinary' } });
		const backwards = await rawRequest(daemon.port, {
			path: `/api/diffs/${id}/lines?version=1&side=new&path=src/long.ts&first=9&last=2`,
			headers: { authorization: `Bearer ${daemon.token}` }
		});
		expect(backwards.status).toBe(400);
		// Said as what is wrong, with no empty field name before it.
		expect(backwards.body).toContain(
			'diff delver could not read this request (the first line comes after the last)'
		);
		// A file the version does not change is said to be so, not that it cannot be marked.
		const gone = await client.readPart(id, part('src/none.ts'));
		expect(gone).toMatchObject({ ok: false, error: { reason: 'FileNotInDiff' } });
		if (!gone.ok) {
			expect(describeApiError(gone.error)).toBe(
				'src/none.ts is not one of the files this version of the diff changes. Reload the page to see the files it changes now.'
			);
		}
		const never = await client.readPart(id, { ...part('src/long.ts'), version: revision(4) });
		expect(never).toMatchObject({ ok: false, error: { status: 409, reason: 'VersionNotFound' } });
	});

	it('opens only files of the pinned snapshot and keeps paths byte-exact', async () => {
		const reading = defineFixture('file-reader-routes', async (repo) => {
			await repo.write('src/format-price.ts', 'export const price = 1;\n');
			await repo.write('notes/format-price.ts', 'export const price = 2;\n');
			await repo.write('src/deleted.txt', 'Only in the base.\n');
			await repo.write('src/empty.txt', '');
			await repo.write('src/binary.bin', Uint8Array.of(1, 0, 255));
			await repo.write('src/huge.txt', 'x'.repeat(4_000_001));
			await repo.writeRaw(Buffer.from('src/oddÿ.txt', 'latin1'), Uint8Array.of(0x68, 0xff));
			await repo.write(String.raw`src/odd\xFF.txt`, 'Literal backslash');
			await repo.symlink('src/link', '../../outside.txt');
			const base = await repo.commit('Initial files');
			repo.setGitlink('submodule', base.commit);
			await repo.write('src/format-price.ts', 'export const price = 3;\n');
			await repo.remove('src/deleted.txt');
			await repo.commit('Change the price');
		});
		const repo = await useFixture(reading);
		const daemon = await testDaemon();
		const client = clientOf(daemon);
		await repo.write('src/format-price.ts', 'export const price = 4;\n');
		const opened = value(await client.start({ directory: repo.dir }));
		if (opened.kind !== 'opened') throw new Error(opened.kind);
		const id = opened.diff.id;
		const version = revision(1);
		const read = (at: string, side: 'old' | 'new' = 'new', seen = version) =>
			client.readFile(id, {
				version: seen,
				side,
				path: path(at),
				first: lineNumberOf(1),
				last: lineNumberOf(1)
			});
		await repo.write('src/format-price.ts', 'export const price = 5;\n');
		await repo.write('src/live-only.txt', 'Never in version one.');
		value(await client.updateDiff(id));
		expect(value(await client.searchFiles(id, version, 'fmtprc'))).toEqual([
			{ path: 'src/format-price.ts', side: 'new', changed: true },
			{ path: 'notes/format-price.ts', side: 'new', changed: false }
		]);
		expect(value(await client.searchFiles(id, version, 'live-only'))).toEqual([]);
		expect(value(await read('src/format-price.ts'))).toMatchObject({
			diffPath: 'src/format-price.ts',
			otherPath: 'src/format-price.ts',
			lines: [{ text: 'export const price = 4;', changed: true }]
		});
		expect(value(await read('src/format-price.ts', 'old')).lines[0]?.text).toBe(
			'export const price = 3;'
		);
		expect(value(await read('src/format-price.ts', 'new', revision(2))).lines[0]?.text).toBe(
			'export const price = 5;'
		);
		expect(value(await read('notes/format-price.ts'))).toMatchObject({
			diffPath: null,
			otherPath: 'notes/format-price.ts'
		});
		expect(value(await read('src/binary.bin')).kind).toBe('binary');
		expect(value(await read('src/huge.txt')).kind).toBe('large');
		expect(value(await read('src/empty.txt')).lineCount).toBe(0);
		expect(value(await read('submodule', 'old')).kind).toBe('submodule');
		expect(value(await read('src/link'))).toMatchObject({
			kind: 'symlink',
			lines: [{ text: '../../outside.txt' }]
		});
		expect(value(await read('src/odd\udcff.txt'))).toMatchObject({
			nonUtf8: true,
			lines: [{ text: 'h�' }]
		});
		expect(value(await read(String.raw`src/odd\xFF.txt`)).lines[0]?.text).toBe('Literal backslash');
		expect(await read('src/link/outside.txt')).toMatchObject({ ok: false, error: { status: 404 } });
		expect(await read('src')).toMatchObject({ ok: false, error: { reason: 'PathIsDirectory' } });
		expect(await read('src/live-only.txt')).toMatchObject({ ok: false, error: { status: 404 } });

		const coloured = value(
			await client.readColours(id, {
				version,
				path: path('notes/format-price.ts'),
				exact: '1',
				old: [],
				new: [{ first: lineNumberOf(1), last: lineNumberOf(1) }]
			})
		);
		expect(coloured.new).toMatchObject({ kind: 'coloured', lines: [{ number: 1 }] });
		const raw = (route: string, query: URLSearchParams) =>
			rawRequest(daemon.port, {
				path: `/api/diffs/${id}/${route}?${query}`,
				headers: { authorization: `Bearer ${daemon.token}` }
			});
		for (const unsafe of [
			'../outside.txt',
			'/etc/passwd',
			'./src/link',
			'src/../src/link',
			'src/a\0b',
			'src//link'
		]) {
			const query = new URLSearchParams({ version: '1', path: unsafe });
			expect(
				(
					await raw(
						'file',
						new URLSearchParams({
							...Object.fromEntries(query),
							side: 'new',
							first: '1',
							last: '2'
						})
					)
				).status
			).toBe(400);
			expect(
				(
					await raw(
						'colours',
						new URLSearchParams({ ...Object.fromEntries(query), exact: '1', new: '1' })
					)
				).status
			).toBe(400);
		}
		expect(
			(
				await raw(
					'file',
					new URLSearchParams({
						version: '1',
						path: 'src/format-price.ts',
						side: 'new',
						first: '1',
						last: '201'
					})
				)
			).status
		).toBe(400);
	});

	it('search the version shown, part by part, and refuse text that is not one line to find', async () => {
		const repo = await useFixture(viewed);
		const daemon = await testDaemon();
		try {
			const client = clientOf(daemon);
			const started = value(await client.start({ directory: repo.dir }));
			if (started.kind !== 'opened') throw new Error(started.kind);
			const id = started.diff.id;
			const { assignments } = value(await client.loadDiff(id));
			const search = (text: string, matchCase = false) =>
				client.searchDiff(id, {
					version: revision(1),
					assignments,
					view: 'sections',
					text: value(parseSearchText(text)),
					matchCase,
					changedOnly: false
				});
			// The hunk around "line ten", three lines either side; the path; nothing in the binary file.
			expect(value(await search('line t')).parts).toEqual([
				{ group: { kind: 'uncategorised' }, path: 'src/long.ts', step: null, matches: 1 }
			]);
			expect(value(await search('LINE', true)).parts).toEqual([]);
			// Ignored files are searched too: the path, and the line on each side.
			expect(value(await search('lock')).parts).toEqual([
				{ group: { kind: 'ignored' }, path: 'pnpm-lock.yaml', step: null, matches: 3 }
			]);
			const auth = { authorization: `Bearer ${daemon.token}` };
			const empty = await rawRequest(daemon.port, {
				path: `/api/diffs/${id}/search?version=1&assignments=${assignments}&view=sections&text=&matchCase=false&changedOnly=false`,
				headers: auth
			});
			expect(empty.status).toBe(400);
			const later = await rawRequest(daemon.port, {
				path: `/api/diffs/${id}/search?version=2&assignments=${assignments}&view=sections&text=x&matchCase=false&changedOnly=false`,
				headers: auth
			});
			// A version the diff never had.
			expect(later.status).toBe(409);
		} finally {
			await daemon.stop();
		}
	});

	it('says a request that got no answer from a running daemon did not reach it, and only one that has stopped has stopped', async () => {
		const repo = await useFixture(viewed);
		const daemon = await testDaemon();
		const started = value(await clientOf(daemon).start({ directory: repo.dir }));
		if (started.kind !== 'opened') throw new Error(started.kind);
		// The browser gives up on requests for lines, as when too many are under way.
		const givingUp: typeof fetch = (input, init) =>
			(input instanceof Request ? input.url : input instanceof URL ? input.href : input).includes(
				'/part?'
			)
				? Promise.reject(new TypeError('Failed to fetch', { cause: new Error('too many') }))
				: fetch(input, init);
		const client = new ApiClient({ fetch: givingUp, base: daemon.origin, token: daemon.token });
		const query: PartQuery = {
			version: revision(1),
			assignments: value(await clientOf(daemon).loadDiff(started.diff.id)).assignments,
			view: 'sections',
			group: { kind: 'uncategorised' },
			path: path('src/new.ts')
		};
		const interrupted = await client.readPart(started.diff.id, query);
		expect(interrupted).toMatchObject({ ok: false, error: { kind: 'interrupted' } });
		if (!interrupted.ok) {
			expect(describeApiError(interrupted.error)).toBe(
				'This did not reach diff delver (too many), though diff delver is running. Try again.'
			);
		}
		await daemon.stop();
		const stopped = await client.readPart(started.diff.id, query);
		expect(stopped).toMatchObject({ ok: false, error: { kind: 'unreachable' } });
		if (!stopped.ok) expect(describeApiError(stopped.error)).toMatch(/It may have stopped/);
	});

	it('stops saying an update unmarked a change once the reviewer has marked it again', async () => {
		const repo = await useFixture(viewed);
		const daemon = await testDaemon();
		const client = clientOf(daemon);
		const started = value(await client.start({ directory: repo.dir }));
		if (started.kind !== 'opened') throw new Error(started.kind);
		const id = started.diff.id;
		const long = async (version: number, reviewed: boolean) => {
			const { sorting } = value(await client.loadDiff(id, 'sections', revision(version)));
			return client.markReviewed(id, {
				version: revision(version),
				target: {
					kind: 'slice',
					group: { kind: 'uncategorised' },
					path: path('src/long.ts'),
					sorting
				},
				reviewed,
				view: 'sections'
			});
		};
		value(await long(1, true));
		// A line next to "line ten" changes: its mark is taken off, and the page says why.
		await repo.write(
			'src/long.ts',
			numbered(1, 9) + 'line ten\nline eleven\n' + numbered(12, 49) + numbered(51, 60)
		);
		value(await client.updateDiff(id));
		const tallyOf = (marked: { parts: readonly { path: string; tally: unknown }[] }) =>
			marked.parts.find((p) => p.path === 'src/long.ts')?.tally;
		const page = value(await client.loadDiff(id));
		expect(tallyOf({ parts: page.groups.flatMap((g) => g.parts) })).toMatchObject({
			unmarked: 2
		});
		// Marked again and unmarked by the reviewer: the update is no longer the reason.
		expect(tallyOf(value(await long(2, true)))).toMatchObject({ unmarked: 0 });
		expect(tallyOf(value(await long(2, false)))).toMatchObject({ reviewed: 0, unmarked: 0 });
	});

	it('marks a part, a file and a group on the version shown, and refuses once the diff was updated', async () => {
		const repo = await useFixture(viewed);
		const daemon = await testDaemon();
		const client = clientOf(daemon);
		const started = value(await client.start({ directory: repo.dir }));
		if (started.kind !== 'opened') throw new Error(started.kind);
		const id = started.diff.id;
		const { sorting } = value(await client.loadDiff(id));

		const marked = value(
			await client.markReviewed(id, {
				version: revision(1),
				target: {
					kind: 'slice',
					group: { kind: 'uncategorised' },
					path: path('src/long.ts'),
					sorting
				},
				reviewed: true,
				view: 'sections'
			})
		);
		expect(marked.summary.progressText).toBe('3 of 5 changes reviewed');
		expect(marked.parts.map((p) => [p.path, p.tally.reviewed, p.tally.units])).toEqual([
			['src/long.ts', 3, 3]
		]);
		expect(marked.files.map((f) => [f.path, f.tally.reviewed])).toEqual([['src/long.ts', 3]]);
		// Every group's figures as stored, which are the sums of its parts on the page.
		const frame = value(await client.loadDiff(id));
		expect(marked.groups).toEqual(
			frame.groups.map((g) => ({
				key: g.key,
				units: g.parts.reduce((n, p) => n + p.tally.units, 0),
				reviewed: g.parts.reduce((n, p) => n + p.tally.reviewed, 0)
			}))
		);

		const group = value(
			await client.markReviewed(id, {
				version: revision(1),
				target: { kind: 'group', group: { kind: 'uncategorised' }, sorting },
				reviewed: true,
				view: 'sections'
			})
		);
		expect(group.summary.progressText).toBe('Everything reviewed: 5 changes');
		expect(group.parts.map((p) => p.path)).toEqual(['logo.png', 'src/long.ts', 'src/new.ts']);
		const listed = value(await client.listDiffs()).diffs[0];
		expect(listed?.kind === 'diff' ? listed.progressText : '').toBe(
			'Everything reviewed: 5 changes'
		);

		const unticked = value(
			await client.markReviewed(id, {
				version: revision(1),
				target: { kind: 'file', path: path('logo.png') },
				reviewed: false,
				view: 'sections'
			})
		);
		expect(unticked.summary.progressText).toBe('4 of 5 changes reviewed');

		// The files change and the diff is updated: a tick sent for version 1 changes nothing.
		const agent = await mcpOverHttp({ origin: daemon.origin, token: daemon.mcpToken });
		onTestFinished(() => agent.close());
		const writeOverview = async (version: number, markdown: string): Promise<void> => {
			const answer = await agent.call('set_overview', { report: id, version, markdown });
			expect(answer.refused, answer.text).toBe(false);
		};
		await writeOverview(1, 'First overview');
		await repo.write('src/new.ts', 'export const n = 2;\n');
		const updated = value(await client.updateDiff(id));
		expect(updated.kind).toBe('updated');
		await writeOverview(2, 'Revised overview');
		const late = await client.markReviewed(id, {
			version: revision(1),
			target: { kind: 'file', path: path('logo.png') },
			reviewed: true,
			view: 'sections'
		});
		expect(late).toMatchObject({ ok: false, error: { status: 409, reason: 'VersionOutOfDate' } });
		if (!late.ok) expect(describeApiError(late.error)).toMatch(/updated to version 2/);
		// The page left on version 1 can still read it, and fetch its ticks again.
		const first = value(await client.refreshDiff(id, 'sections', revision(1), frame.frame));
		if (first === null) throw new Error('The first version’s overview changed.');
		expect(first.summary.version).toBe(1);
		expect(first.overview).toBe('First overview');
		expect(first.files.find((f) => f.path === 'logo.png')?.tally.reviewed).toBe(0);
		expect(value(await client.loadDiff(id)).summary.version).toBe(2);
		const old = value(
			await client.readPart(id, {
				version: revision(1),
				assignments: first.assignments,
				view: 'sections',
				group: { kind: 'uncategorised' },
				path: path('src/new.ts')
			})
		);
		const block = old.blocks[0];
		expect(block?.kind === 'hunk' ? block.lines.map((l) => l.text) : []).toEqual([
			'export const n = 1;'
		]);
		const now = value(await client.loadDiff(id));
		expect(now.overview).toBe('Revised overview');
		const fresh = now.groups.flatMap((g) => g.parts).find((p) => p.path === 'src/new.ts');
		expect(fresh?.tally).toEqual({ units: 1, reviewed: 0, fresh: 1, unmarked: 0 });
	});

	it('refuses stale slice and group ticks, including after another connection writes or the daemon restarts', async () => {
		const repo = await useFixture(viewed);
		const dataDirectory = await tempDirectory();
		const daemon = await testDaemon({ dataDirectory });
		const client = clientOf(daemon);
		const started = value(await client.start({ directory: repo.dir }));
		if (started.kind !== 'opened') throw new Error(started.kind);
		const id = started.diff.id;
		const version = revision(1);
		const agent = await mcpOverHttp({ origin: daemon.origin, token: daemon.mcpToken });
		onTestFinished(() => agent.close());
		const section = value(parseSectionId('first'));
		const group = { kind: 'section', section } as const;
		const write = async (tool: string, args: Readonly<Record<string, unknown>>) => {
			const answer = await agent.call(tool, { ...args, report: id, version });
			expect(answer.refused, answer.text).toBe(false);
		};
		await write('upsert_sections', { sections: [{ id: section, title: 'First' }] });
		await write('assign', { items: [{ file: 'src/long.ts', lines: '+10', section }] });
		const elsewhere = value(
			await ReportService.open({
				dataDirectory,
				ids: sequentialIds(),
				clock: settableClock(value(parseTimestamp(0)))
			})
		);
		onTestFinished(() => {
			elsewhere.close();
		});
		const first = value(await client.loadDiff(id));
		expect(value(await client.refreshDiff(id, 'sections', version, first.frame))).toBeNull();

		const expectStale = async (caller: ApiClient, frame: DiffPage): Promise<void> => {
			const { sorting, assignments } = frame;
			for (const target of [
				{ kind: 'slice', group, path: path('src/long.ts'), sorting },
				{ kind: 'group', group, sorting }
			] as const) {
				expect(
					await caller.markReviewed(id, { version, target, reviewed: true, view: 'sections' })
				).toMatchObject({ ok: false, error: { status: 409, reason: 'SortingChanged' } });
			}
			expect(
				await caller.readPart(id, {
					version,
					assignments,
					view: 'sections',
					group,
					path: path('src/long.ts')
				})
			).toMatchObject({ ok: false, error: { status: 409, reason: 'AssignmentsChanged' } });
			expect(value(await caller.refreshDiff(id, 'sections', version, frame.frame))).not.toBeNull();
			expect(value(await caller.loadDiff(id)).summary.progress.reviewed).toBe(0);
		};
		await write('assign', { items: [{ file: 'src/long.ts', lines: '-10', section }] });
		await expectStale(client, first);
		const second = value(await client.loadDiff(id));
		const assigned = value(
			await elsewhere.assign(id, version, [{ file: 'src/long.ts', lines: '-50', section }])
		);
		expect(assigned.rejected).toEqual([]);
		await expectStale(client, second);
		const third = value(await client.loadDiff(id));
		await agent.close();
		await daemon.stop();
		const restarted = clientOf(await testDaemon({ dataDirectory }));
		await expectStale(restarted, third);

		const current = value(await restarted.loadDiff(id));
		const marked = value(
			await restarted.markReviewed(id, {
				version,
				target: { kind: 'file', path: path('src/long.ts') },
				reviewed: true,
				view: 'sections'
			})
		);
		expect(marked.summary.progress.reviewed).toBe(3);
		const refreshed = value(await restarted.refreshDiff(id, 'sections', version, current.frame));
		expect(refreshed?.sorting).toBe(current.sorting);
		expect(refreshed?.summary.progress.reviewed).toBe(3);
	});

	it('binds lazy part reads and searches to the frame even when assignments go back to their original places', async () => {
		const repo = await useFixture(viewed);
		await repo.write(
			'src/long.ts',
			numbered(1, 9) + 'line ten\n' + numbered(11, 49) + 'line fifty\n' + numbered(51, 60)
		);
		const daemon = await testDaemon();
		const client = clientOf(daemon);
		const started = value(await client.start({ directory: repo.dir }));
		if (started.kind !== 'opened') throw new Error(started.kind);
		const id = started.diff.id;
		const version = revision(1);
		const agent = await mcpOverHttp({ origin: daemon.origin, token: daemon.mcpToken });
		onTestFinished(() => agent.close());
		const section = value(parseSectionId('first'));
		const group = { kind: 'section', section } as const;
		const file = 'src/long.ts';
		const write = async (tool: string, args: Readonly<Record<string, unknown>>) => {
			const answer = await agent.call(tool, { ...args, report: id, version });
			expect(answer.refused, answer.text).toBe(false);
		};
		await write('upsert_sections', {
			sections: [
				{ id: section, title: 'First' },
				{ id: 'second', title: 'Second' }
			]
		});
		const arrange = async (first: string, second: string) =>
			write('assign', {
				items: [
					{ file, lines: first, section },
					{ file, lines: second, section: 'second' }
				]
			});
		const lazy = (assignments: string) =>
			client.readPart(id, { version, assignments, view: 'sections', group, path: path(file) });
		const search = (assignments: string) =>
			client.searchDiff(id, {
				version,
				assignments,
				view: 'sections',
				text: value(parseSearchText('line 10')),
				matchCase: true,
				changedOnly: true
			});
		const visible = async (assignments: string) =>
			value(await lazy(assignments)).blocks.flatMap((block) =>
				block.kind === 'hunk'
					? block.lines
							.filter((line) => line.kind === 'deleted' && line.home.kind === 'here')
							.map((line) => line.text)
					: []
			);
		const stale = { ok: false, error: { status: 409, reason: 'AssignmentsChanged' } };

		await arrange('+10,-10', '+50,-50');
		const first = value(await client.loadDiff(id));
		expect(await visible(first.assignments)).toEqual(['line 10']);
		expect(value(await search(first.assignments)).parts.map((part) => part.group)).toEqual([group]);

		await arrange('+50,-50', '+10,-10');
		expect(await lazy(first.assignments)).toMatchObject(stale);
		expect(await search(first.assignments)).toMatchObject(stale);
		const intermediate = value(await client.loadDiff(id));
		expect(intermediate.groups).toEqual(first.groups);
		expect(await visible(intermediate.assignments)).toEqual(['line 50']);
		expect(value(await search(intermediate.assignments)).parts.map((part) => part.group)).toEqual([
			{ kind: 'section', section: 'second' }
		]);

		await arrange('+10,-10', '+50,-50');
		const restored = value(await client.loadDiff(id));
		expect(restored.groups).toEqual(first.groups);
		expect(await lazy(first.assignments)).toMatchObject(stale);
		expect(await lazy(intermediate.assignments)).toMatchObject(stale);
		expect(await search(intermediate.assignments)).toMatchObject(stale);
		expect(await visible(restored.assignments)).toEqual(['line 10']);
		expect(value(await search(restored.assignments)).parts.map((part) => part.group)).toEqual([
			group
		]);
	});

	it('keeps a pinned frame unchanged through settings and writes to another Delve', async () => {
		const repo = await useFixture(viewed);
		const another = await useFixture(viewed);
		const client = clientOf(await testDaemon());
		const first = value(await client.start({ directory: repo.dir }));
		if (first.kind !== 'opened') throw new Error(first.kind);
		const id = first.diff.id;
		const frame = value(await client.loadDiff(id));
		const version = frame.summary.version;

		value(await client.changeSetting({ name: 'colours', value: false }));
		const second = value(await client.start({ directory: another.dir }));
		if (second.kind !== 'opened') throw new Error(second.kind);
		expect(second.diff.id).not.toBe(id);
		value(
			await client.markReviewed(second.diff.id, {
				version: second.diff.version,
				view: 'sections',
				target: { kind: 'file', path: path('src/long.ts') },
				reviewed: true
			})
		);
		expect(value(await client.refreshDiff(id, 'sections', version, frame.frame))).toBeNull();
	});
});

describe('private draft comments', () => {
	it('keeps comments on either side and on the version they were made on', async () => {
		const repo = await useFixture(viewed);
		const daemon = await testDaemon();
		const command = clientOf(daemon);
		const client = await browserClient(daemon);
		const started = value(await client.start({ directory: repo.dir }));
		if (started.kind !== 'opened') throw new Error(started.kind);
		const id = started.diff.id;
		expect(value(await client.draftComments(id)).comments).toEqual([]);

		const request: AddDraftComment = {
			kind: 'comment',
			version: revision(1),
			anchor: {
				path: path('src/long.ts'),
				side: 'new',
				first: lineNumberOf(14),
				last: lineNumberOf(16)
			},
			body: 'Can these three unchanged lines be simplified?'
		};
		expect(await command.draftComments(id)).toMatchObject({
			ok: false,
			error: { status: 403, reason: 'BrowserSessionRequired' }
		});
		expect(await command.addDraftComment(id, request)).toMatchObject({
			ok: false,
			error: { status: 403, reason: 'BrowserSessionRequired' }
		});
		const cookie = await browserCookie(daemon);
		const endpoint = `/api/diffs/${id}/comments`;
		expect(
			(
				await rawRequest(daemon.port, {
					path: endpoint,
					headers: { cookie: `${daemon.reviewCookie}=${daemon.token}` }
				})
			).status
		).toBe(403);
		expect(
			(
				await rawRequest(daemon.port, {
					method: 'POST',
					path: endpoint,
					headers: { cookie, origin: 'http://example.test', 'content-type': 'application/json' },
					body: JSON.stringify(request)
				})
			).status
		).toBe(403);

		const after = value(await client.addDraftComment(id, request));
		expect(after).toMatchObject(request);
		const before = value(
			await client.addDraftComment(id, {
				...request,
				anchor: { ...request.anchor, side: 'old', first: lineNumberOf(60), last: lineNumberOf(60) },
				body: 'Keep the original last line.'
			})
		);
		expect(before.anchor.side).toBe('old');
		const refused = [
			{ ...request.anchor, last: lineNumberOf(60) },
			{ ...request.anchor, first: lineNumberOf(17) },
			{ ...request.anchor, path: path('logo.png') },
			{ ...request.anchor, path: path('src/new.ts'), side: 'old' }
		] satisfies (typeof after.anchor)[];
		for (const anchor of refused) {
			expect(await client.addDraftComment(id, { ...request, anchor })).toMatchObject({
				ok: false,
				error: { status: 422, reason: 'InvalidCommentRange' }
			});
		}
		expect(await client.addDraftComment(id, { ...request, body: '  \n' })).toMatchObject({
			ok: false,
			error: { status: 400 }
		});
		expect(value(await client.loadDiff(id)).summary.progress).toEqual(started.diff.progress);

		await repo.write('src/new.ts', 'export const n = 2;\n');
		expect(value(await client.updateDiff(id)).kind).toBe('updated');
		expect(await client.addDraftComment(id, request)).toMatchObject({
			ok: false,
			error: { status: 409, reason: 'VersionOutOfDate' }
		});
		const reopened = await browserClient(daemon);
		expect(value(await reopened.draftComments(id)).comments).toEqual([after, before]);
		value(await reopened.closeDiff(id));
		expect(value(await reopened.draftComments(id)).comments).toEqual([after, before]);
		expect(await reopened.addDraftComment(id, { ...request, version: revision(2) })).toMatchObject({
			ok: false,
			error: { status: 409, reason: 'ReportClosed' }
		});
	});

	it('changes and deletes a comment only from a page that shows the current version', async () => {
		const repo = await useFixture(viewed);
		const clock = settableClock(at(Date.UTC(2026, 0, 15, 9, 30)));
		const daemon = await testDaemon({ clock });
		const client = await browserClient(daemon);
		const started = value(await client.start({ directory: repo.dir }));
		if (started.kind !== 'opened') throw new Error(started.kind);
		const id = started.diff.id;
		const add = (body: string, first: number) =>
			client.addDraftComment(id, {
				kind: 'comment',
				version: revision(1),
				anchor: {
					path: path('src/long.ts'),
					side: 'new',
					first: lineNumberOf(first),
					last: lineNumberOf(first)
				},
				body
			});
		type Saved = DraftCommentView;
		/** A change or a deletion as a page sends it: with the version it shows and the words it read. */
		const change = (comment: Saved, shown: number, body: string, edits = comment.edits) =>
			client.editDraftComment(id, comment.id, { version: revision(shown), edits, body });
		const remove = (comment: Saved, shown: number, edits = comment.edits) =>
			client.deleteDraftComment(id, comment.id, { version: revision(shown), edits });
		const written = clock.now();
		const first = value(await add('Is ten the right number?', 10));
		const second = value(await add('And this one.', 11));
		expect(first).toMatchObject({ writtenAt: written, editedAt: null, edits: 0 });
		expect(value(await client.draftComments(id))).toEqual({
			now: written,
			comments: [first, second],
			overall: { body: '', changedAt: null, edits: 0 },
			resolutions: []
		});

		// Its words change; its lines, its version and when it was written do not.
		clock.advance(90_000);
		const edited = value(await change(first, 1, 'Is ten the right number?\nIt was nine before.'));
		expect(edited).toEqual({
			...first,
			body: 'Is ten the right number?\nIt was nine before.',
			editedAt: clock.now(),
			edits: 1
		});
		// The same words again change nothing, not even when they were edited.
		clock.advance(1_000);
		expect(value(await change(edited, 1, edited.body))).toEqual(edited);
		expect(value(await client.draftComments(id))).toEqual({
			now: clock.now(),
			comments: [edited, second],
			overall: { body: '', changedAt: null, edits: 0 },
			resolutions: []
		});

		// A page that read the words before that change, as another tab did, changes
		// and deletes nothing: it would be acting on words it has not seen.
		for (const answer of [await change(first, 1, 'From the other tab.'), await remove(first, 1)]) {
			expect(answer).toMatchObject({ ok: false, error: { status: 409, reason: 'CommentChanged' } });
			if (!answer.ok)
				expect(describeApiError(answer.error)).toMatch(/changed since this page read/);
		}
		expect(value(await client.draftComments(id)).comments).toEqual([edited, second]);

		const missing = { ...first, id: commentId(99) };
		const refusals = [
			// A comment needs words: the service says so, as for any change it cannot make.
			[await change(edited, 1, ' \n'), 422],
			[await change(edited, 1, 'x'.repeat(10_001)), 400],
			// No such comment, in this Delve or at all.
			[await change(missing, 1, 'x'), 404],
			[await remove(missing, 1), 404],
			// A version the Delve never had.
			[await change(edited, 2, 'x'), 409],
			[await remove(edited, 2), 409]
		] as const;
		for (const [answer, status] of refusals) {
			expect(answer).toMatchObject({ ok: false, error: { status } });
		}

		// A comment belongs to its own Delve: another Delve's address does not reach it.
		const another = await useFixture(viewed);
		const other = value(await client.start({ directory: another.dir }));
		if (other.kind !== 'opened') throw new Error(other.kind);
		for (const answer of [
			await client.editDraftComment(other.diff.id, edited.id, {
				version: revision(1),
				edits: edited.edits,
				body: 'x'
			}),
			await client.deleteDraftComment(other.diff.id, edited.id, {
				version: revision(1),
				edits: edited.edits
			})
		]) {
			expect(answer).toMatchObject({
				ok: false,
				error: { status: 404, reason: 'CommentNotFound' }
			});
		}

		// Only a browser that may write drafts, from the daemon's own pages.
		const endpoint = `/api/diffs/${id}/comments/${String(first.id)}`;
		const cookie = await browserCookie(daemon);
		const body = JSON.stringify({ version: 1, edits: 1, body: 'From somewhere else.' });
		// Said outright: Node sends no length of its own with a DELETE.
		const json = { 'content-type': 'application/json', 'content-length': String(body.length) };
		for (const method of ['POST', 'DELETE']) {
			for (const headers of [
				{ authorization: `Bearer ${daemon.token}`, ...json },
				{ authorization: `Bearer ${daemon.mcpToken}`, ...json },
				{ cookie, origin: 'http://example.test', ...json },
				{ cookie, ...json },
				{ origin: daemon.origin, ...json }
			]) {
				expect(
					(await rawRequest(daemon.port, { method, path: endpoint, headers, body })).status,
					`${method} ${JSON.stringify(Object.keys(headers))}`
				).toBe(403);
			}
			expect(
				(
					await rawRequest(daemon.port, {
						method,
						path: `/api/diffs/${id}/comments/first`,
						headers: { cookie, origin: daemon.origin, ...json },
						body
					})
				).status
			).toBe(404);
		}
		expect(value(await client.draftComments(id)).comments).toEqual([edited, second]);

		// The Delve moves on: a page still on version 1 changes nothing, and is told why.
		await repo.write('src/new.ts', 'export const n = 2;\n');
		expect(value(await client.updateDiff(id)).kind).toBe('updated');
		for (const answer of [
			await change(edited, 1, 'Typed on the old page.'),
			await remove(second, 1)
		]) {
			expect(answer).toMatchObject({
				ok: false,
				error: { status: 409, reason: 'VersionOutOfDate' }
			});
		}
		expect(value(await client.draftComments(id)).comments).toEqual([edited, second]);

		// From the new version, a comment whose lines are in the old one can still be changed and deleted.
		clock.advance(60_000);
		const later = value(await change(edited, 2, 'Shorter.'));
		expect(later).toMatchObject({ version: 1, body: 'Shorter.', editedAt: clock.now(), edits: 2 });
		expect(value(await remove(second, 2))).toEqual(second);
		expect(value(await client.draftComments(id)).comments).toEqual([later]);
		expect(await remove(second, 2)).toMatchObject({
			ok: false,
			error: { status: 404, reason: 'CommentNotFound' }
		});

		// A closed Delve can be read, not changed.
		value(await client.closeDiff(id));
		for (const answer of [await change(later, 2, 'x'), await remove(later, 2)]) {
			expect(answer).toMatchObject({ ok: false, error: { status: 409, reason: 'ReportClosed' } });
		}
		expect(value(await client.draftComments(id)).comments).toEqual([later]);
	});

	it('never gives a deleted comment’s number to another, so a page that is behind reaches nothing', async () => {
		const repo = await useFixture(viewed);
		const dataDirectory = await tempDirectory();
		const daemon = await testDaemon({ dataDirectory });
		const client = await browserClient(daemon);
		const started = value(await client.start({ directory: repo.dir }));
		if (started.kind !== 'opened') throw new Error(started.kind);
		const id = started.diff.id;
		const add = (file: string, body: string) =>
			client.addDraftComment(id, {
				kind: 'comment',
				version: revision(1),
				anchor: { path: path(file), side: 'new', first: lineNumberOf(1), last: lineNumberOf(1) },
				body
			});

		// One tab saves a comment and another deletes it; the first still shows it.
		const shownInOldTab = value(await add('src/long.ts', 'On the long file.'));
		value(
			await client.deleteDraftComment(id, shownInOldTab.id, {
				version: revision(1),
				edits: shownInOldTab.edits
			})
		);
		// The next comment, on another file, is a different comment with a different number.
		const next = value(await add('src/new.ts', 'On the new file.'));
		expect(next.id).toBeGreaterThan(shownInOldTab.id);

		// What the first tab does to the comment it still shows is refused, and changes nothing.
		const staleEdit = await client.editDraftComment(id, shownInOldTab.id, {
			version: revision(1),
			edits: shownInOldTab.edits,
			body: 'Meant for the long file.'
		});
		const staleDelete = await client.deleteDraftComment(id, shownInOldTab.id, {
			version: revision(1),
			edits: shownInOldTab.edits
		});
		for (const answer of [staleEdit, staleDelete]) {
			expect(answer).toMatchObject({
				ok: false,
				error: { status: 404, reason: 'CommentNotFound' }
			});
		}
		expect(value(await client.draftComments(id)).comments).toEqual([next]);

		// Nor after every comment is deleted, nor after the daemon starts again.
		value(
			await client.deleteDraftComment(id, next.id, { version: revision(1), edits: next.edits })
		);
		expect(value(await client.draftComments(id)).comments).toEqual([]);
		const after = value(await add('src/long.ts', 'After all were deleted.'));
		expect(after.id).toBeGreaterThan(next.id);
		value(
			await client.deleteDraftComment(id, after.id, { version: revision(1), edits: after.edits })
		);
		await daemon.stop();
		const restarted = await testDaemon({ dataDirectory });
		const again = await browserClient(restarted);
		const last = value(
			await again.addDraftComment(id, {
				kind: 'comment',
				version: revision(1),
				anchor: {
					path: path('src/long.ts'),
					side: 'new',
					first: lineNumberOf(2),
					last: lineNumberOf(2)
				},
				body: 'After a restart.'
			})
		);
		expect(last.id).toBeGreaterThan(after.id);
	});
});

describe('finished reviews', () => {
	it('lists, previews and finishes only for a browser that may write drafts, on the draft it showed', async () => {
		const repo = await useFixture(viewed);
		const daemon = await testDaemon();
		// The agent opens the report and gives the person a link, which lets a browser read and tick only.
		const agent = await mcpOverHttp({
			origin: daemon.origin,
			token: daemon.mcpToken,
			directory: repo.dir
		});
		onTestFinished(() => agent.close());
		const created = await agent.call('create_report', {});
		const id = value(parseReportId(reportIn(created)));
		const link = new URL(/in their browser: (http:\S+)/.exec(created.text)?.[1] ?? '');
		const entered = await rawRequest(daemon.port, { path: link.pathname + link.search });
		const view = entered.headers['set-cookie']?.[0]?.split(';', 1)[0] ?? '';
		expect(view.split('=', 1)[0]).toBe(viewCookieName(daemon.port));
		const review = await browserCookie(daemon);
		const client = await browserClient(daemon);

		const list = `/api/diffs/${id}/reviews`;
		const preview = `${list}/preview?version=1`;
		const json = { 'content-type': 'application/json' };
		const finish = (headers: Readonly<Record<string, string>>, body: unknown) =>
			rawRequest(daemon.port, { method: 'POST', path: list, headers, body: JSON.stringify(body) });
		const refusedReason = (body: string): string =>
			ApiErrorBodySchema.parse(JSON.parse(body)).error.kind;

		// Neither a browser let in by a link, nor one with no cookie, nor another site may.
		for (const cookie of [{ cookie: view }, {}]) {
			for (const path of [list, preview]) {
				const answer = await rawRequest(daemon.port, { path, headers: cookie });
				expect(answer.status, path).toBe(403);
			}
			const answer = await finish(
				{ ...cookie, ...json, origin: daemon.origin },
				{ version: 1, comments: [], overall: 0 }
			);
			expect(answer.status).toBe(403);
		}
		expect(
			refusedReason((await rawRequest(daemon.port, { path: list, headers: { cookie: view } })).body)
		).toBe('BrowserSessionRequired');
		expect(
			(
				await finish(
					{ cookie: review, ...json, origin: 'http://example.test' },
					{ version: 1, comments: [], overall: 0 }
				)
			).status
		).toBe(403);

		// The reviewer's own browser lists none yet, and cannot finish an empty draft.
		const none = await rawRequest(daemon.port, { path: list, headers: { cookie: review } });
		expect(none.status).toBe(200);
		expect(none.headers['cache-control']).toBe('no-store');
		expect(JSON.parse(none.body)).toMatchObject({ reviews: [] });
		const empty = await finish(
			{ cookie: review, ...json, origin: daemon.origin },
			{ version: 1, comments: [], overall: 0 }
		);
		expect(empty.status).toBe(422);
		expect(refusedReason(empty.body)).toBe('NothingToFinish');

		const comment = value(
			await client.addDraftComment(id, {
				kind: 'comment',
				version: revision(1),
				anchor: {
					path: path('src/long.ts'),
					side: 'new',
					first: lineNumberOf(10),
					last: lineNumberOf(10)
				},
				body: 'Why spell it out?'
			})
		);
		const previewed = await rawRequest(daemon.port, { path: preview, headers: { cookie: review } });
		expect(previewed.status).toBe(200);
		expect(previewed.headers['cache-control']).toBe('no-store');
		expect(JSON.parse(previewed.body)).toMatchObject({
			number: 1,
			comments: [{ id: comment.id, edits: comment.edits }],
			overall: 0
		});

		// A page that showed another draft finishes nothing.
		const stale = await finish(
			{ cookie: review, ...json, origin: daemon.origin },
			{ version: 1, comments: [], overall: 0 }
		);
		expect(stale.status).toBe(409);
		expect(refusedReason(stale.body)).toBe('DraftChanged');

		const shown = { version: 1, comments: [{ id: comment.id, edits: comment.edits }], overall: 0 };
		const finished = await finish({ cookie: review, ...json, origin: daemon.origin }, shown);
		expect(finished.status).toBe(201);
		expect(finished.headers['cache-control']).toBe('no-store');
		expect(JSON.parse(finished.body)).toMatchObject({ number: 1, version: 1, comments: 1 });

		// Finishing the same comments again says they were finished, as review 1.
		const twice = await finish({ cookie: review, ...json, origin: daemon.origin }, shown);
		expect(twice.status).toBe(409);
		expect(refusedReason(twice.body)).toBe('CommentsFinished');
		const listed = await rawRequest(daemon.port, { path: list, headers: { cookie: review } });
		expect(JSON.parse(listed.body)).toMatchObject({ reviews: [{ number: 1 }] });
	});
});

describe('the overall review', () => {
	it('is read with the draft and saved only by a browser that may write drafts, on the words it read', async () => {
		const repo = await useFixture(viewed);
		const daemon = await testDaemon();
		const command = clientOf(daemon);
		const client = await browserClient(daemon);
		const started = value(await client.start({ directory: repo.dir }));
		if (started.kind !== 'opened') throw new Error(started.kind);
		const id = started.diff.id;
		expect(value(await client.draftComments(id)).overall).toEqual({
			body: '',
			changedAt: null,
			edits: 0
		});

		// The command's token, a browser with only the token in a cookie, and another site may not.
		expect(await command.saveOverallReview(id, { edits: NO_EDITS, body: 'No.' })).toMatchObject({
			ok: false,
			error: { status: 403, reason: 'BrowserSessionRequired' }
		});
		const endpoint = `/api/diffs/${id}/overall`;
		const cookie = await browserCookie(daemon);
		const json = { 'content-type': 'application/json' };
		for (const headers of [
			{ cookie: `${daemon.reviewCookie}=${daemon.token}`, ...json, origin: daemon.origin },
			{ cookie, ...json, origin: 'http://example.test' }
		]) {
			const answer = await rawRequest(daemon.port, {
				method: 'POST',
				path: endpoint,
				headers,
				body: JSON.stringify({ edits: 0, body: 'No.' })
			});
			expect(answer.status).toBe(403);
		}

		const words = 'Looks right overall.\n\n```\nnot code\n```';
		const saved = value(await client.saveOverallReview(id, { edits: NO_EDITS, body: words }));
		expect(saved).toMatchObject({ body: words, edits: 1 });
		expect(value(await client.draftComments(id)).overall).toEqual(saved);

		// A page that read the words before that changes nothing, and is told why.
		const stale = await client.saveOverallReview(id, { edits: NO_EDITS, body: 'Elsewhere.' });
		expect(stale).toMatchObject({
			ok: false,
			error: { status: 409, reason: 'OverallReviewChanged' }
		});
		// Words longer than it holds are refused before they reach it.
		const long = await rawRequest(daemon.port, {
			method: 'POST',
			path: endpoint,
			headers: { cookie, ...json, origin: daemon.origin },
			body: JSON.stringify({ edits: 1, body: 'x'.repeat(20_001) })
		});
		expect(long.status).toBe(400);
		expect(value(await client.draftComments(id)).overall.body).toBe(words);

		// It is finished on its own, and the finished review says it holds one.
		const preview = value(await client.previewReview(id, revision(1)));
		expect(preview).toMatchObject({ comments: [], overall: 1 });
		expect(preview.text).toContain('## Overall\n\n> Looks right overall.\n>\n> ```\n');
		const finished = value(
			await client.finishReview(id, {
				version: revision(1),
				comments: [],
				overall: preview.overall
			})
		);
		expect(finished).toMatchObject({ number: 1, comments: 0, overall: true, text: preview.text });
		expect(value(await client.draftComments(id)).overall).toMatchObject({ body: '', edits: 2 });
		expect(value(await client.reviews(id)).reviews).toMatchObject([{ number: 1, overall: true }]);
	});
});
