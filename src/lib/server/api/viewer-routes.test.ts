/**
 * The viewer's routes against a real daemon, through the typed client: the
 * page's frame, one part's lines, unchanged lines to open, and marking reviewed
 * on the version shown, refused once the diff was updated.
 */
import { describe, expect, it } from 'vitest';
import { ApiClient, describeApiError } from '#lib/api/client.ts';
import type { PartQuery } from '#lib/api/schemas.ts';
import { escapedRepoPath } from '#lib/core/path-bytes.ts';
import { parseRepoPath } from '#lib/core/repo-path.tiny.ts';
import { parseRevisionNumber, type RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { lineNumberOf } from '#lib/core/line-number.tiny.ts';
import { parseSearchText } from '#lib/core/search/search-text.tiny.ts';
import { clientOf, rawRequest, testDaemon } from '../../../../tests/support/daemons.ts';
import { defineFixture, useFixture } from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';

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
		expect(logo).toEqual({ blocks: [], sizes: { old: 8, new: 10 } });

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

	it('search the version shown, part by part, and refuse text that is not one line to find', async () => {
		const repo = await useFixture(viewed);
		const daemon = await testDaemon();
		try {
			const client = clientOf(daemon);
			const started = value(await client.start({ directory: repo.dir }));
			if (started.kind !== 'opened') throw new Error(started.kind);
			const id = started.diff.id;
			const search = (text: string, matchCase = false) =>
				client.searchDiff(id, {
					version: revision(1),
					view: 'sections',
					text: value(parseSearchText(text)),
					matchCase,
					changedOnly: false
				});
			// The hunk around "line ten", three lines either side; the path; nothing in the binary file.
			expect(value(await search('line t')).parts).toEqual([
				{ group: { kind: 'uncategorised' }, path: 'src/long.ts', matches: 1 }
			]);
			expect(value(await search('LINE', true)).parts).toEqual([]);
			// Ignored files are searched too: the path, and the line on each side.
			expect(value(await search('lock')).parts).toEqual([
				{ group: { kind: 'ignored' }, path: 'pnpm-lock.yaml', matches: 3 }
			]);
			const auth = { authorization: `Bearer ${daemon.token}` };
			const empty = await rawRequest(daemon.port, {
				path: `/api/diffs/${id}/search?version=1&view=sections&text=&matchCase=false&changedOnly=false`,
				headers: auth
			});
			expect(empty.status).toBe(400);
			const later = await rawRequest(daemon.port, {
				path: `/api/diffs/${id}/search?version=2&view=sections&text=x&matchCase=false&changedOnly=false`,
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
		const long = (version: number, reviewed: boolean) =>
			client.markReviewed(id, {
				version: revision(version),
				target: { kind: 'slice', group: { kind: 'uncategorised' }, path: path('src/long.ts') },
				reviewed,
				view: 'sections'
			});
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

		const marked = value(
			await client.markReviewed(id, {
				version: revision(1),
				target: { kind: 'slice', group: { kind: 'uncategorised' }, path: path('src/long.ts') },
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
				target: { kind: 'group', group: { kind: 'uncategorised' } },
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
		await repo.write('src/new.ts', 'export const n = 2;\n');
		const updated = value(await client.updateDiff(id));
		expect(updated.kind).toBe('updated');
		const late = await client.markReviewed(id, {
			version: revision(1),
			target: { kind: 'file', path: path('logo.png') },
			reviewed: true,
			view: 'sections'
		});
		expect(late).toMatchObject({ ok: false, error: { status: 409, reason: 'VersionOutOfDate' } });
		if (!late.ok) expect(describeApiError(late.error)).toMatch(/updated to version 2/);
		// The page left on version 1 can still read it, and fetch its ticks again.
		const first = value(await client.loadDiff(id, 'sections', revision(1)));
		expect(first.summary.version).toBe(1);
		expect(first.files.find((f) => f.path === 'logo.png')?.tally.reviewed).toBe(0);
		expect(value(await client.loadDiff(id)).summary.version).toBe(2);
		const old = value(
			await client.readPart(id, {
				version: revision(1),
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
		const fresh = now.groups.flatMap((g) => g.parts).find((p) => p.path === 'src/new.ts');
		expect(fresh?.tally).toEqual({ units: 1, reviewed: 0, fresh: 1, unmarked: 0 });
	});
});
