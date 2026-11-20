import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	arbitraryDiff,
	runAtScale,
	syntheticDiff
} from '../../../../tests/support/synthetic-diff.ts';
import { recordTime } from '../../../../tests/support/measured-time.ts';
import { now } from '../../../../tests/support/stopwatch.ts';
import { measurementName } from '../measurement-name.tiny.ts';
import { millisecondsOf } from '../milliseconds.tiny.ts';
import { parseSectionId, type SectionId } from '../section-id.tiny.ts';
import { assign, type AssignRequest } from './assign.ts';
import { coverage, describeWarning, type CoverageWarning } from './coverage.ts';
import { autoIgnore } from './auto-ignore.ts';
import { initialState } from './state.ts';
import { unitCountOf } from '../unit-count.tiny.ts';

function section(id: string): SectionId {
	const parsed = parseSectionId(id);
	if (!parsed.ok) throw new Error(`bad section ${id}`);
	return parsed.value;
}

// src/app.ts: h1 is one run, -2 -3 +2 +3 +4. h2 is +11.
const diff = syntheticDiff([
	{ path: 'assets/logo.png', change: 'binary' },
	{ path: 'src/app.test.ts', change: 'added', lines: 4 },
	{
		path: 'src/app.ts',
		change: 'modified',
		hunks: [
			{ gap: 0, lines: [' ', '-', '-', '+', '+', '+', ' '] },
			{ gap: 4, lines: [' ', '+', ' '] }
		]
	}
]);

const stateAfter = (requests: readonly AssignRequest[]): ReturnType<typeof initialState> =>
	assign(diff, initialState(diff), requests).state;

const kinds = (warnings: readonly CoverageWarning[]): readonly string[] =>
	warnings.map((w) => w.kind);

describe('coverage', () => {
	it('starts with everything uncategorised and listed', () => {
		const result = coverage(diff, initialState(diff));
		expect(result.total).toEqual({ units: 11, files: 3 });
		expect(result.uncategorised).toEqual({ units: 11, files: 3 });
		expect(result.ignored).toEqual({ units: 0, files: 0 });
		expect(result.remaining).toEqual([
			{ kind: 'file', path: 'assets/logo.png' },
			{ kind: 'lines', path: 'src/app.test.ts', ranges: [{ side: 'new', first: 1, last: 4 }] },
			{
				kind: 'lines',
				path: 'src/app.ts',
				ranges: [
					{ side: 'old', first: 2, last: 3 },
					{ side: 'new', first: 2, last: 4 },
					{ side: 'new', first: 11, last: 11 }
				]
			}
		]);
	});

	it('totals each bucket in units and in files', () => {
		const state = stateAfter([
			{ file: 'src/app.ts', hunks: ['h1'], section: 'alpha' },
			{ file: 'src/app.ts', hunks: ['h2'], section: 'beta' },
			{ file: 'src/app.test.ts', section: 'alpha' },
			{ file: 'assets/logo.png', section: 'ignored', reason: 'Artwork' }
		]);
		const result = coverage(diff, state, { sections: [section('alpha'), section('beta')] });
		expect([...result.sections]).toEqual([
			['alpha', { units: 9, files: 2 }],
			['beta', { units: 1, files: 1 }]
		]);
		expect(result.ignored).toEqual({ units: 1, files: 1 });
		expect(result.uncategorised).toEqual({ units: 0, files: 0 });
		expect(result.remaining).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	it('warns about empty and oversized sections', () => {
		const state = stateAfter([{ file: 'src/app.ts', section: 'alpha' }]);
		const result = coverage(diff, state, {
			sections: [section('alpha'), section('empty')],
			maxSectionUnits: unitCountOf(5)
		});
		expect(result.warnings.filter((w) => w.kind !== 'TestsOutsideSections')).toEqual([
			{ kind: 'OversizedSection', section: 'alpha', units: 6, limit: 5 },
			{ kind: 'EmptySection', section: 'empty' }
		]);
	});

	it('warns about a run of changed lines split between buckets', () => {
		const state = stateAfter([
			{ file: 'src/app.ts', lines: '-2..-3,+2', section: 'alpha' },
			{ file: 'src/app.ts', lines: '+3..+4', section: 'beta' }
		]);
		const split = coverage(diff, state).warnings.filter((w) => w.kind === 'SplitChangeRun');
		expect(split).toEqual([
			{
				kind: 'SplitChangeRun',
				path: 'src/app.ts',
				hunk: 'h1',
				ranges: [
					{ side: 'old', first: 2, last: 3 },
					{ side: 'new', first: 2, last: 4 }
				],
				buckets: [
					{ kind: 'section', section: 'alpha' },
					{ kind: 'section', section: 'beta' }
				]
			}
		]);
	});

	it('does not warn about a run split only between reasons for ignoring it', () => {
		const state = stateAfter([
			{ file: 'src/app.ts', lines: '-2..-3', section: 'ignored', reason: 'Generated' },
			{ file: 'src/app.ts', lines: '+2..+4', section: 'ignored', reason: 'Vendored' }
		]);
		expect(kinds(coverage(diff, state).warnings)).not.toContain('SplitChangeRun');
	});

	it('names Ignored once when a run is split between a section and two ignored reasons', () => {
		const state = stateAfter([
			{ file: 'src/app.ts', lines: '-2', section: 'ignored', reason: 'Generated' },
			{ file: 'src/app.ts', lines: '-3', section: 'ignored', reason: 'Vendored' },
			{ file: 'src/app.ts', lines: '+2..+4', section: 'alpha' }
		]);
		const [split] = coverage(diff, state).warnings.filter((w) => w.kind === 'SplitChangeRun');
		expect(split === undefined ? '' : describeWarning(split)).toContain(
			'are split between Ignored and section "alpha".'
		);
	});

	it('warns about test lines in no section, but not ones a rule ignored', () => {
		const tests = coverage(diff, initialState(diff)).warnings.filter(
			(w) => w.kind === 'TestsOutsideSections'
		);
		expect(tests).toEqual([
			{
				kind: 'TestsOutsideSections',
				units: {
					kind: 'lines',
					path: 'src/app.test.ts',
					ranges: [{ side: 'new', first: 1, last: 4 }]
				}
			}
		]);

		const vendored = syntheticDiff([{ path: 'vendor/x/x_test.go', change: 'added', lines: 2 }]);
		const ignored = autoIgnore(vendored, initialState(vendored)).state;
		expect(kinds(coverage(vendored, ignored).warnings)).toEqual([]);
	});

	it('explains every warning', () => {
		const state = stateAfter([
			{ file: 'src/app.ts', lines: '-2', section: 'alpha' },
			{ file: 'assets/logo.png', role: 'snapshot' }
		]);
		const result = coverage(diff, state, {
			sections: [section('alpha'), section('empty')],
			maxSectionUnits: unitCountOf(0)
		});
		expect(new Set(kinds(result.warnings))).toEqual(
			new Set(['EmptySection', 'OversizedSection', 'SplitChangeRun', 'TestsOutsideSections'])
		);
		for (const warning of result.warnings)
			expect(describeWarning(warning).length).toBeGreaterThan(30);
	});

	it('always adds up: buckets sum to the total, and the remaining list is the uncategorised count', () => {
		const request = fc.record(
			{
				glob: fc.constantFrom('*.ts', 'src/**', '*.md'),
				section: fc.constantFrom('alpha', 'beta', 'ignored'),
				reason: fc.constant('Reason')
			},
			{ requiredKeys: ['glob', 'section'] }
		);
		fc.assert(
			fc.property(arbitraryDiff, fc.array(request, { maxLength: 4 }), (d, requests) => {
				const state = assign(d, initialState(d), requests).state;
				const result = coverage(d, state);
				const sectionUnits = [...result.sections.values()].reduce((n, t) => n + t.units, 0);
				expect(sectionUnits + result.ignored.units + result.uncategorised.units).toBe(d.unitCount);
				const listed = result.remaining.reduce(
					(n, u) =>
						n + (u.kind === 'file' ? 1 : u.ranges.reduce((m, r) => m + r.last - r.first + 1, 0)),
					0
				);
				expect(listed).toBe(result.uncategorised.units);
			}),
			{ numRuns: 50 }
		);
	});
});

describe('the pure model at scale', () => {
	it('reads, assigns and covers 500 files and 50,000 changed lines quickly', ({ task }) => {
		const { elapsed, unitCount, uncategorised } = runAtScale(500, now);
		expect(unitCount).toBe(50_000);
		expect(uncategorised).toBe(50_000 - 10_000 - 10);
		// The full size, 2,000 files and 200,000 lines, is measured in src/lib/scale.test.ts,
		// and src/lib/work-growth.test.ts holds the work to linear growth.
		recordTime(
			task,
			measurementName('reading, assigning and covering'),
			millisecondsOf(elapsed),
			millisecondsOf(150)
		);
	});
});
