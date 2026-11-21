import { describe, expect, it } from 'vitest';
import { syntheticDiff } from '../../../../tests/support/synthetic-diff.ts';
import { assign } from '../diff/assign.ts';
import { initialState } from '../diff/state.ts';
import { parseReportId } from '../report-id.tiny.ts';
import { reviewerMessage } from '../reviewer-message.tiny.ts';
import { parseRevisionNumber } from '../revision-number.tiny.ts';
import { parseSectionId } from '../section-id.tiny.ts';
import { parseSectionTitle } from '../section-title.tiny.ts';
import type { Section } from '../reports/report.ts';
import {
	boundedAnswer,
	grouped,
	MAX_ANSWER_LENGTH,
	PAGE_LENGTH,
	type ReportHeading
} from './answer.ts';
import { renderAssign } from './assign-answer.ts';
import { renderCoverage } from './coverage-answer.ts';
import { diffPosition, renderDiffPage, type DiffPageInput } from './diff-pages.ts';
import { manifestPosition, renderManifest, type ManifestInput } from './manifest.ts';
import { filterKey, pageCursor, parsePageCursor } from './page-cursor.tiny.ts';

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
	if (!result.ok) throw new Error(JSON.stringify(result.error));
	return result.value;
}

const heading: ReportHeading = {
	id: value(parseReportId('r_1')),
	title: reviewerMessage('Uncommitted changes'),
	repository: reviewerMessage('shop'),
	version: value(parseRevisionNumber(2))
};

/** 2,000 files of 50 changed lines in two hunks, as the large fixture has. */
const large = syntheticDiff(
	Array.from({ length: 2_000 }, (_, i) => ({
		path: `src/module-${String(Math.floor(i / 100)).padStart(2, '0')}/file-${String(i).padStart(4, '0')}.ts`,
		change: 'modified' as const,
		hunks: [
			{ gap: 2, lines: [...Array<'-'>(12).fill('-'), ...Array<'+'>(12).fill('+'), ' '] as const },
			{ gap: 20, lines: [' ', ...Array<'+'>(26).fill('+')] as const }
		]
	}))
);

function cursorOf(text: string): string | undefined {
	return /"cursor": "([^"]+)"/.exec(text)?.[1];
}

describe('answers for an agent', () => {
	it('write and read a cursor, and refuse anything else', () => {
		const at = { version: 3, file: 40, line: 7, key: filterKey('x') };
		expect(value(parsePageCursor(pageCursor(at)))).toEqual(at);
		for (const bad of ['', 'v1-f2', 'v1-f2-l3-kX', 'v-1-f2-l3-k1', `v1-f2-l3-${'k'.repeat(30)}`]) {
			expect(parsePageCursor(bad).ok).toBe(false);
		}
		expect(filterKey('a')).not.toBe(filterKey('b'));
	});

	it('page the manifest of 2,000 files, each file once, every page short', () => {
		const input: ManifestInput = {
			heading,
			diff: large,
			state: initialState(large),
			sections: [],
			references: new Map(),
			overview: undefined,
			leftOut: []
		};
		const seen: string[] = [];
		let from = 0;
		let pages = 0;
		for (;;) {
			const text = renderManifest(input, from);
			pages += 1;
			expect(text.length).toBeLessThanOrEqual(PAGE_LENGTH + 1_000);
			expect(text.split('\n')[0]).toBe('Report r_1: Uncommitted changes in shop, version 2.');
			seen.push(...text.split('\n').filter((l) => l.startsWith('src/module-')));
			const cursor = cursorOf(text);
			if (cursor === undefined) break;
			const position = value(parsePageCursor(cursor));
			expect(manifestPosition(position, input)).toBe(true);
			from = position.file;
		}
		expect(pages).toBeGreaterThan(2);
		expect(pages).toBeLessThan(10);
		expect(seen).toHaveLength(2_000);
		expect(new Set(seen).size).toBe(2_000);
		expect(seen[0]).toBe(
			'src/module-00/file-0000.ts: changed, +38 -12, h1..h2, code; not sorted 50'
		);
		// A cursor of another version, another key or past the end does not fit.
		const at = { version: 2, file: 5, line: 0, key: filterKey('manifest') };
		expect(manifestPosition({ ...at, version: 1 }, input)).toBe(false);
		expect(manifestPosition({ ...at, key: filterKey('other') }, input)).toBe(false);
		expect(manifestPosition({ ...at, file: 2_000 }, input)).toBe(false);
	});

	it('split a file longer than a page, carrying on from its hunk header, and keep shorter files whole', () => {
		const diff = syntheticDiff([
			{ path: 'a.ts', change: 'modified', hunks: [{ gap: 0, lines: ['+', '-'] }] },
			{ path: 'big.ts', change: 'added', lines: 20_000 },
			{ path: 'c.ts', change: 'modified', hunks: [{ gap: 0, lines: ['+'] }] }
		]);
		const input: DiffPageInput = {
			heading,
			files: diff.files,
			asked: 'the whole diff',
			key: 'k1',
			repeat: ''
		};
		const labels: string[] = [];
		let start = { file: 0, line: 0 };
		const pages: string[] = [];
		for (;;) {
			const text = renderDiffPage(input, start);
			pages.push(text);
			expect(text.length).toBeLessThanOrEqual(PAGE_LENGTH + 1_000);
			labels.push(...text.split('\n').flatMap((l) => /^\+(\d+) /.exec(l)?.[1] ?? []));
			const cursor = cursorOf(text);
			if (cursor === undefined) break;
			const position = value(parsePageCursor(cursor));
			expect(diffPosition(position, input)).toBe(true);
			start = { file: position.file, line: position.line };
		}
		expect(pages.length).toBeGreaterThan(5);
		expect(pages[1]).toMatch(/^## big\.ts \(continued\)\n@@ h1 -0,0 \+1,20000 @@ \(continued\)$/m);
		expect(pages.at(-1)).toMatch(/## c\.ts/);
		expect(pages.at(-1)).toMatch(/That was the last page\./);
		// Every added line of big.ts once, and the one of a.ts and c.ts.
		expect(labels).toHaveLength(20_002);
		expect(new Set(labels.filter((l, i) => i > 0 && i < labels.length - 1)).size).toBe(20_000);
	});

	it('list what is left of 2,000 files briefly, and count the rest', () => {
		const text = renderCoverage({
			heading,
			diff: large,
			state: initialState(large),
			sections: [],
			overview: undefined
		});
		expect(text.length).toBeLessThanOrEqual(PAGE_LENGTH);
		expect(text).toMatch(/^Not sorted yet: 100,000 change lines in 2,000 files/m);
		expect(text).toMatch(/^src\/module-00\/file-0000\.ts -3\.\.-14,\+3\.\.\+14,\+37\.\.\+62$/m);
		expect(text).toMatch(/… and [\d,]+ more files\. Sort whole files or globs first/);
		expect(text).toMatch(/Next: make sections with upsert_sections/);
	});

	it('say what each assign item took, and that sending it again is harmless', () => {
		const diff = syntheticDiff([
			{ path: 'a.ts', change: 'modified', hunks: [{ gap: 0, lines: ['-', '+', '+'] }] }
		]);
		const section: Section = {
			id: value(parseSectionId('app')),
			title: value(parseSectionTitle('App')),
			summary: undefined
		};
		const requests = [
			{ file: 'a.ts', section: 'app' },
			{ file: 'a.ts', lines: '+40', section: 'app' },
			{ file: 'b.ts', section: 'app' }
		];
		const first = assign(diff, initialState(diff), requests, {
			knownSections: new Set([section.id])
		});
		const again = assign(diff, first.state, requests.slice(0, 1), {
			knownSections: new Set([section.id])
		});
		const text = (outcome: typeof first, sent: typeof requests) =>
			renderAssign({ heading, diff, requests: sent, outcome });
		expect(text(first, requests).split('\n')).toEqual([
			'Report r_1: Uncommitted changes in shop, version 2.',
			'1 of 3 items were applied; 2 refused. Fix the refused ones and send only those again.',
			'Item 0: took 3 change lines into section "app".',
			"Item 1 was refused, and changed nothing: a.ts: +40 holds no changed line, so nothing was assigned for this item. A range takes the changed lines inside it and may span unchanged ones, but an item's ranges must hold at least one between them. Nearby: +1..+2. Use the +/- labels from get_diff.",
			'Item 2 was refused, and changed nothing: "b.ts" is not a changed file in this diff. Use a path from get_manifest; a deleted file goes by its old path, any other file by its new path.',
			'',
			'Nothing is left to sort: every change line is in a section or ignored. Next: get_coverage, for warnings and what is still to write.'
		]);
		expect(text(again, requests.slice(0, 1)).split('\n')[2]).toBe(
			'Item 0: nothing more to take, everything it names is already in section "app".'
		);
	});

	it('cut an answer that would be too long, at a line, and say so', () => {
		const long = Array.from({ length: 10_000 }, (_, i) => `line ${grouped(i)}`).join('\n');
		const cut = boundedAnswer(long);
		expect(cut.length).toBeLessThanOrEqual(MAX_ANSWER_LENGTH);
		expect(cut).toMatch(/\nline [\d,]+\n\[The rest of this answer was cut/);
		expect(boundedAnswer('short')).toBe('short');
	});
});
