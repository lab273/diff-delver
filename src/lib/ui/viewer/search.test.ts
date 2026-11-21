/**
 * Searching within the diff as the page does it (`search.svelte.ts`), against
 * a real daemon through the typed client the page uses: counting what the
 * daemon found with what the page opened, and moving from match to match,
 * round at both ends, past parts the filter hides or that are closed.
 */
import { describe, expect, it } from 'vitest';
import { ApiClient } from '#lib/api/client.ts';
import { DEFAULT_SETTINGS, type ViewSettings } from '#lib/core/settings.ts';
import { partIndexOf, type PartIndex } from '#lib/core/part-index.tiny.ts';
import { testDaemon } from '../../../../tests/support/daemons.ts';
import { defineFixture, useFixture } from '../../../../tests/support/fixture-repos.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { Viewer } from './viewer.svelte.ts';
import type { CurrentMatch } from './search.svelte.ts';

const numbered = (n: number): string => `const n${String(n)} = ${String(n)};`;

/** Sixty lines with an unchanged `findme` among the hidden ones, at line 30. */
const A_BEFORE = Array.from({ length: 60 }, (_, i) =>
	i + 1 === 30 ? '// findme, unchanged' : numbered(i + 1)
);
const A_AFTER = A_BEFORE.map((line, i) =>
	i + 1 === 10 ? 'const findme10 = 10;' : i + 1 === 50 ? "const findme50 = 'findme';" : line
);

/** Thirty lines, two of them indented with spaces, which the change turns to tabs. */
const D_BEFORE = Array.from({ length: 30 }, (_, i) =>
	i + 1 === 2 ? '  spaced2();' : i + 1 === 25 ? '  spaced25();' : numbered(i + 1)
);
const D_AFTER = D_BEFORE.map((line) => line.replace(/^ {2}/, '\t'));

/**
 * `a.ts`: a match in its first hunk, two in its second and one in the
 * unchanged lines between them; `b.ts`, new, two; `c.ts`, none; `d.ts`, two
 * hunks that only change white space.
 */
const searched = defineFixture('viewer-search', async (repo) => {
	await repo.write('a.ts', `${A_BEFORE.join('\n')}\n`);
	await repo.write('c.ts', 'nothing\n');
	await repo.write('d.ts', `${D_BEFORE.join('\n')}\n`);
	await repo.commit('base');
	await repo.write('d.ts', `${D_AFTER.join('\n')}\n`);
	await repo.write('a.ts', `${A_AFTER.join('\n')}\n`);
	await repo.write('b.ts', 'findme b\nfindme c\n');
	await repo.write('c.ts', 'nothing at all\n');
});

const A = partIndexOf(0);
const B = partIndexOf(1);
const D = partIndexOf(3);

/** A fetch that holds back, or fails, the lines of one part while a test says so. */
class HeldFetch {
	#held: Promise<void> | undefined;
	#release: (() => void) | undefined;
	#arrived: (() => void) | undefined;
	failing = false;
	/** Settled when a request for `b.ts`'s lines has come while they are held. */
	arrived: Promise<void> = Promise.resolve();

	/** Holds the answers to requests for `b.ts`'s lines until `release` is called. */
	hold(): void {
		this.#held = new Promise((resolve) => {
			this.#release = resolve;
		});
		this.arrived = new Promise((resolve) => {
			this.#arrived = resolve;
		});
	}

	release(): void {
		this.#release?.();
		this.#held = undefined;
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.includes('/part?') && url.includes('path=b.ts')) {
			if (this.failing) throw new TypeError('fetch failed');
			this.#arrived?.();
			await this.#held;
		}
		return fetch(input, init);
	};
}

async function opened(settings: Partial<ViewSettings> = {}) {
	const repo = await useFixture(searched);
	const daemon = await testDaemon();
	const held = new HeldFetch();
	const client = new ApiClient({ fetch: held.fetch, base: daemon.origin, token: daemon.token });
	const started = value(await client.start({ directory: repo.dir }));
	if (started.kind !== 'opened') throw new Error(started.kind);
	const page = value(await client.loadDiff(started.diff.id));
	const viewer = new Viewer(page, false, { ...DEFAULT_SETTINGS, ...settings }, client);
	return { viewer, search: viewer.search, held };
}

/** Where a match is, for comparing: its part and line, or its part's name. */
function where(viewer: Viewer, match: CurrentMatch | undefined): string {
	if (match === undefined) return 'none';
	const path = viewer.parts[match.at]?.part.path ?? '?';
	return match.place.kind === 'path'
		? `${path} name`
		: `${path} ${match.place.line.text.slice(match.place.start, match.place.start + 12)} ${String(match.place.start)}`;
}

async function steps(viewer: Viewer, moves: readonly boolean[]): Promise<string[]> {
	const seen: string[] = [];
	for (const forward of moves) {
		const moved = await viewer.search.step(forward);
		seen.push(`${String(viewer.search.ordinal)} ${where(viewer, moved)}`);
	}
	return seen;
}

async function searchFor(viewer: Viewer, text: string): Promise<void> {
	viewer.search.text = text;
	await viewer.search.search();
}

function partOf(viewer: Viewer, at: PartIndex) {
	const state = viewer.parts[at];
	if (state === undefined) throw new Error(`No part ${String(at)}`);
	return state;
}

/** The first block of hidden lines after a part's first hunk. */
function hiddenBetweenHunks(viewer: Viewer, at: PartIndex): number {
	const lines = partOf(viewer, at).lines;
	if (lines.kind !== 'loaded') throw new Error(lines.kind);
	const firstHunk = lines.blocks.findIndex((b) => b.kind === 'hunk');
	return lines.blocks.findIndex((b, i) => b.kind === 'hidden' && i > firstHunk);
}

describe('searching within the diff on its page', () => {
	it('goes from match to match, round at both ends, and round within the one part that has them all', async () => {
		const { viewer, search } = await opened();
		await searchFor(viewer, 'findme');
		expect(search.summary).toBe('5 matches in 2 files. Press Enter to go to the first.');
		expect(await steps(viewer, [true, true, true, true, true, true])).toEqual([
			'1 a.ts findme10 = 1 6',
			"2 a.ts findme50 = ' 6",
			"3 a.ts findme'; 18",
			'4 b.ts findme b 0',
			'5 b.ts findme c 0',
			'1 a.ts findme10 = 1 6'
		]);
		// Previous from the first goes round to the last.
		expect(await steps(viewer, [false, false])).toEqual(['5 b.ts findme c 0', '4 b.ts findme b 0']);
		expect(search.summary).toBe('4 of 5 matches in 2 files');

		// Every match in one part: round within it, both ways.
		await searchFor(viewer, 'const findme');
		expect(search.summary).toBe('2 matches in 1 file. Press Enter to go to the first.');
		expect(await steps(viewer, [true, true, true, false, false])).toEqual([
			'1 a.ts const findme 0',
			'2 a.ts const findme 0',
			'1 a.ts const findme 0',
			'2 a.ts const findme 0',
			'1 a.ts const findme 0'
		]);
		expect(where(viewer, search.current)).toBe('a.ts const findme 0');
	});

	it('counts matches in unchanged lines the page opened, in their place among the others', async () => {
		const { viewer, search } = await opened();
		await searchFor(viewer, 'findme');
		await viewer.load(A);
		await viewer.openLines(A, hiddenBetweenHunks(viewer, A), 'all');
		expect(search.matchesIn(A)).toBe(4);
		expect(search.summary).toBe('6 matches in 2 files. Press Enter to go to the first.');
		expect(await steps(viewer, [true, true, true])).toEqual([
			'1 a.ts findme10 = 1 6',
			'2 a.ts findme, unch 3',
			"3 a.ts findme50 = ' 6"
		]);
		// With Changed lines only, the opened line is not read.
		search.changedOnly = true;
		await search.search();
		expect(search.matchesIn(A)).toBe(3);
		expect(search.summary).toBe('5 matches in 2 files. Press Enter to go to the first.');
	});

	it('passes over parts the filter hides, and closed parts with Skip closed files', async () => {
		const { viewer, search } = await opened();
		await viewer.tick({ kind: 'part', at: B }, true);
		expect(partOf(viewer, B).open).toBe(false);
		await searchFor(viewer, 'findme');
		expect(search.summary).toBe('5 matches in 2 files. Press Enter to go to the first.');

		viewer.onlyWaiting = true;
		expect(search.summary).toBe('3 matches in 1 file. Press Enter to go to the first.');
		expect(await steps(viewer, [true, true, true, true])).toEqual([
			'1 a.ts findme10 = 1 6',
			"2 a.ts findme50 = ' 6",
			"3 a.ts findme'; 18",
			'1 a.ts findme10 = 1 6'
		]);
		expect(await steps(viewer, [false])).toEqual(["3 a.ts findme'; 18"]);

		viewer.onlyWaiting = false;
		search.skipClosed = true;
		expect(search.summary).toBe('3 of 3 matches in 1 file');
		expect(await steps(viewer, [true])).toEqual(['1 a.ts findme10 = 1 6']);
		search.skipClosed = false;
		expect(await steps(viewer, [false])).toEqual(['5 b.ts findme c 0']);
		// Moving to a match in a closed part opened it; the search puts it back.
		expect(partOf(viewer, B).open).toBe(true);
		search.close();
		expect(partOf(viewer, B).open).toBe(false);
	});

	it('stays on the match the person is on when lines are opened above it in its part', async () => {
		const { viewer, search } = await opened();
		await searchFor(viewer, 'findme');
		expect(await steps(viewer, [true, true])).toEqual([
			'1 a.ts findme10 = 1 6',
			"2 a.ts findme50 = ' 6"
		]);
		await viewer.openLines(A, hiddenBetweenHunks(viewer, A), 'all');
		// The opened line's match comes before it now: the same match, counted third.
		expect(where(viewer, search.current)).toBe("a.ts findme50 = ' 6");
		expect(search.summary).toBe('3 of 6 matches in 2 files');
		// The mark drawn as the current one is on that line, at that offset.
		const place = search.current?.place;
		if (place?.kind !== 'line') throw new Error('Not on a line');
		const marked = [...(search.marksIn(A)?.lines.entries() ?? [])].flatMap(([line, marks]) =>
			marks.filter((m) => m.current).map((m) => ({ line, start: m.start }))
		);
		expect(marked).toEqual([{ line: place.line, start: 6 }]);
		expect(place.line.text).toBe("const findme50 = 'findme';");
		expect(await steps(viewer, [true])).toEqual(["4 a.ts findme'; 18"]);
		expect(await steps(viewer, [false, false])).toEqual([
			"3 a.ts findme50 = ' 6",
			'2 a.ts findme, unch 3'
		]);
	});

	it('says no place among the matches once the one the person is on is hidden or skipped, and goes on from it', async () => {
		const { viewer, search } = await opened();
		await searchFor(viewer, 'findme');
		expect(await steps(viewer, [true, true, true, true])).toContain('4 b.ts findme b 0');
		// Ticking it closes it, and the filter hides it.
		await viewer.tick({ kind: 'part', at: B }, true);
		viewer.onlyWaiting = true;
		expect(search.ordinal).toBeUndefined();
		expect(search.summary).toBe('3 matches in 1 file. Press Enter to go to the next.');
		expect(search.describeCurrent()).toBe(search.summary);
		expect(await steps(viewer, [false])).toEqual(["3 a.ts findme'; 18"]);

		// With Skip closed files, a part ticked, and so closed, stops counting too.
		viewer.onlyWaiting = false;
		await viewer.tick({ kind: 'part', at: B }, false);
		expect(await steps(viewer, [true])).toEqual(['4 b.ts findme b 0']);
		search.skipClosed = true;
		await viewer.tick({ kind: 'part', at: B }, true);
		expect(search.summary).toBe('3 matches in 1 file. Press Enter to go to the next.');
		expect(await steps(viewer, [true])).toEqual(['1 a.ts findme10 = 1 6']);
	});

	it('waits for lines already on their way before moving into their part, and says when they cannot be read', async () => {
		const { viewer, held } = await opened();
		await searchFor(viewer, 'findme');
		expect(await steps(viewer, [true, true, true])).toContain("3 a.ts findme'; 18");
		// b.ts's lines are on their way, as when it comes near the screen, and held.
		held.hold();
		const coming = viewer.load(B);
		await held.arrived;
		expect(partOf(viewer, B).lines.kind).toBe('loading');
		const moving = steps(viewer, [true]);
		// Let go once the move has had every chance to go on without them.
		setTimeout(() => {
			held.release();
		}, 0);
		expect(await moving).toEqual(['4 b.ts findme b 0']);
		await coming;

		// Lines that cannot be read: the move stops there and says so, and the next tries again.
		const again = await opened();
		await searchFor(again.viewer, 'findme');
		expect(await steps(again.viewer, [true, true, true])).toContain("3 a.ts findme'; 18");
		again.held.failing = true;
		expect(await again.search.step(true)).toBeUndefined();
		expect(again.search.summary).toMatch(
			/^Could not read the lines of b\.ts, so its matches cannot be shown\. .+ Press Enter to try again\.$/
		);
		expect(where(again.viewer, again.search.current)).toBe("a.ts findme'; 18");
		again.held.failing = false;
		expect(await steps(again.viewer, [true])).toEqual(['4 b.ts findme b 0']);
	});
	it('does nothing once a newer version has taken the search over while a move waited', async () => {
		const { viewer, search, held } = await opened();
		await searchFor(viewer, 'findme');
		expect(await steps(viewer, [true, true, true])).toContain("3 a.ts findme'; 18");
		const before = { current: viewer.current, match: where(viewer, search.current) };
		// The move waits for b.ts's lines; meanwhile a newer version takes over.
		held.hold();
		const moving = search.step(true);
		await held.arrived;
		search.handOver();
		held.release();
		expect(await moving).toBeUndefined();
		expect({ current: viewer.current, match: where(viewer, search.current) }).toEqual(before);
	});
	it('puts back the white space it showed on the very hunk it showed it in, and on no other', async () => {
		const { viewer, search } = await opened({ hideWhiteSpace: true });
		viewer.hideWhiteSpace = true;
		await searchFor(viewer, 'spaced2();');
		expect(await steps(viewer, [true])).toEqual(['1 d.ts spaced2(); 2']);
		const hunks = (): boolean[] => {
			const lines = partOf(viewer, D).lines;
			if (lines.kind !== 'loaded') throw new Error(lines.kind);
			return lines.blocks.flatMap((b) => (b.kind === 'hunk' ? [b.showWhiteSpace] : []));
		};
		// The match is in a change drawn as an unchanged line: its hunk shows its changes.
		expect(hunks()).toEqual([true, false]);
		search.close();
		expect(hunks()).toEqual([false, false]);

		// Moved to again, and the part's lines fetched afresh, with the person
		// showing every white-space change: closing the search leaves them shown.
		search.open = true;
		await searchFor(viewer, 'spaced2();');
		await steps(viewer, [true]);
		partOf(viewer, D).lines = { kind: 'waiting' };
		await viewer.load(D);
		viewer.showWhiteSpace(D);
		search.close();
		expect(hunks()).toEqual([true, true]);
	});
	it('says where the match is, on which side, and why text cannot be searched for', async () => {
		const { viewer, search } = await opened();
		await searchFor(viewer, 'n10 = 10');
		await steps(viewer, [true]);
		expect(search.describeCurrent()).toBe(
			'1 of 1 match in 1 file, in a.ts, removed line 10, as it was numbered before the change.'
		);
		await searchFor(viewer, 'findme10');
		await steps(viewer, [true]);
		expect(search.describeCurrent()).toBe('1 of 1 match in 1 file, in a.ts, line 10.');
		await searchFor(viewer, 'a.t');
		await steps(viewer, [true]);
		expect(search.describeCurrent()).toBe('1 of 1 match in 1 file, in the name of a.ts.');

		await searchFor(viewer, 'find\u0000me');
		expect(search.summary).toBe(
			'That holds a NUL character, which no line of text holds: leave it out.'
		);
		await searchFor(viewer, 'find\nme');
		expect(search.summary).toBe('Search for text on one line.');
	});
});
