import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	arbitraryAssignScenario,
	marksFrom,
	syntheticDiff
} from '../../../../tests/support/synthetic-diff.ts';
import { assign } from '../diff/assign.ts';
import { groupKeyId } from '../group-key-id.tiny.ts';
import { initialState, type AssignmentState } from '../diff/state.ts';
import type { Diff } from '../diff/diff.ts';
import type { GroupKey, ViewKind } from '../diff/slices.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import { parseSectionId } from '../section-id.tiny.ts';
import { describeMarkError, markReviewed, type ReviewTarget } from './mark-reviewed.ts';
import { reviewProgress, unitProgressOf } from './progress.ts';
import { NO_MARKS, reviewedLines, type ReviewedMarks } from './reviewed-marks.ts';

function path(text: string): RepoPath {
	const parsed = parseRepoPath(text);
	if (!parsed.ok) throw new Error(text);
	return parsed.value;
}

function section(id: string): GroupKey {
	const parsed = parseSectionId(id);
	if (!parsed.ok) throw new Error(id);
	return { kind: 'section', section: parsed.value };
}

// src/app.ts: -2, +2, +3 in one hunk, +11 in another; src/app.test.ts: +1..+3;
// package-lock.json: +1; logo.png: binary.
const diff = syntheticDiff([
	{ path: 'logo.png', change: 'binary' },
	{ path: 'package-lock.json', change: 'added', lines: 1 },
	{ path: 'src/app.test.ts', change: 'added', lines: 3 },
	{
		path: 'src/app.ts',
		change: 'modified',
		hunks: [
			{ gap: 0, lines: [' ', '-', '+', '+', ' '] },
			{ gap: 5, lines: [' ', '+', ' '] }
		]
	}
]);
const app = path('src/app.ts');
const appTest = path('src/app.test.ts');

/** app.ts split between two sections, its test in the first, the lockfile ignored, the image unsorted. */
const state: AssignmentState = assign(diff, initialState(diff), [
	{ file: 'src/app.ts', lines: '-2,+2..+3', section: 'alpha' },
	{ file: 'src/app.ts', lines: '+11', section: 'beta' },
	{ file: 'src/app.test.ts', section: 'alpha', role: 'test' },
	{ file: 'package-lock.json', section: 'ignored', reason: 'Lockfile' }
]).state;

function marked(
	marks: ReviewedMarks,
	target: ReviewTarget,
	reviewed = true,
	view: ViewKind = 'sections'
): ReviewedMarks {
	const result = markReviewed(diff, state, marks, target, reviewed, view);
	if (!result.ok) throw new Error(describeMarkError(result.error));
	return result.value.marks;
}

describe('marking reviewed', () => {
	it('marks exactly one slice of a file split across sections', () => {
		const marks = marked(NO_MARKS, { kind: 'slice', group: section('alpha'), path: app });
		expect([...reviewedLines(marks, app, 'old').values()]).toEqual([2]);
		expect([...reviewedLines(marks, app, 'new').values()]).toEqual([2, 3]);
		const beta = marked(marks, { kind: 'slice', group: section('beta'), path: app });
		expect([...reviewedLines(beta, app, 'new').values()]).toEqual([2, 3, 11]);
		const undone = marked(beta, { kind: 'slice', group: section('alpha'), path: app }, false);
		expect([...reviewedLines(undone, app, 'new').values()]).toEqual([11]);
		expect([...reviewedLines(undone, app, 'old').values()]).toEqual([]);
	});

	it('marks a whole file, a whole group, and a file-level unit', () => {
		const file = marked(NO_MARKS, { kind: 'file', path: app });
		expect(reviewedLines(file, app, 'new').size + reviewedLines(file, app, 'old').size).toBe(4);
		const group = marked(NO_MARKS, { kind: 'group', group: section('alpha') });
		expect([...group.files.keys()].sort()).toEqual([appTest, app].sort());
		const image = marked(NO_MARKS, { kind: 'group', group: { kind: 'uncategorised' } });
		expect(image.files.get(path('logo.png'))).toEqual({ kind: 'file' });
		expect(marked(image, { kind: 'file', path: path('logo.png') }, false).files.size).toBe(0);
	});

	it('marks the tests of a section apart from its code in the tests-separate view', () => {
		const parsed = parseSectionId('alpha');
		if (!parsed.ok) throw new Error('alpha');
		const tests: GroupKey = { kind: 'tests', section: parsed.value };
		const marks = marked(NO_MARKS, { kind: 'group', group: tests }, true, 'tests-separate');
		expect([...marks.files.keys()]).toEqual([appTest]);
	});

	it('refuses a file not in the diff, and a slice with nothing in it', () => {
		const missing = markReviewed(
			diff,
			state,
			NO_MARKS,
			{ kind: 'file', path: path('nope.ts') },
			true,
			'sections'
		);
		expect(missing.ok ? undefined : missing.error.kind).toBe('FileNotInDiff');
		const empty = markReviewed(
			diff,
			state,
			NO_MARKS,
			{ kind: 'slice', group: section('beta'), path: appTest },
			true,
			'sections'
		);
		expect(empty.ok ? undefined : empty.error.kind).toBe('NothingToMark');
		if (!empty.ok) expect(describeMarkError(empty.error)).toMatch(/Reload the page/);
	});
});

describe('review progress', () => {
	it('counts units and slices per group, per file and overall, with Ignored beside the total', () => {
		const marks = marked(NO_MARKS, { kind: 'slice', group: section('alpha'), path: app });
		const progress = reviewProgress(diff, state, marks, 'sections');
		expect(progress.overall).toEqual({ units: 8, reviewedUnits: 3, slices: 4, reviewedSlices: 1 });
		expect(progress.ignored).toEqual({ units: 1, reviewedUnits: 0, slices: 1, reviewedSlices: 0 });
		expect(progress.uncategorised).toBe(1);
		expect(progress.groups.get(groupKeyId(section('alpha')))?.tally).toEqual({
			units: 6,
			reviewedUnits: 3,
			slices: 2,
			reviewedSlices: 1
		});
		expect(progress.files.get(app)?.tally).toEqual({
			units: 4,
			reviewedUnits: 3,
			slices: 2,
			reviewedSlices: 1
		});
		expect(unitProgressOf(progress)).toEqual({
			counted: 8,
			reviewed: 3,
			ignored: 1,
			uncategorised: 1
		});
	});

	it('adds up for any state and any marks, in both views', () => {
		fc.assert(
			fc.property(
				arbitraryAssignScenario,
				fc.array(fc.boolean(), { minLength: 1, maxLength: 32 }),
				fc.constantFrom<ViewKind>('sections', 'tests-separate'),
				([d, calls], flags, view) => {
					let s = initialState(d);
					for (const call of calls) s = assign(d, s, call).state;
					const p = reviewProgress(d, s, marksFrom(d, flags), view);
					expect(p.overall.units + p.ignored.units).toBe(d.unitCount);
					expect(p.overall.reviewedUnits).toBeLessThanOrEqual(p.overall.units);
					const groups = [...p.groups.values()].map((g) => g.tally);
					expect(groups.reduce((n, t) => n + t.units, 0)).toBe(d.unitCount);
					expect(groups.reduce((n, t) => n + t.slices, 0)).toBe(
						p.overall.slices + p.ignored.slices
					);
					const files = [...p.files.values()];
					expect(files.reduce((n, f) => n + f.tally.reviewedUnits, 0)).toBe(
						p.overall.reviewedUnits
					);
				}
			),
			{ numRuns: 100 }
		);
	});

	it('is complete once every group is marked, and empty once every file is unmarked', () => {
		fc.assert(
			fc.property(arbitraryAssignScenario, ([d, calls]) => {
				let s = initialState(d);
				for (const call of calls) s = assign(d, s, call).state;
				let marks = NO_MARKS;
				for (const g of reviewProgress(d, s, marks, 'sections').groups.values()) {
					const result = markReviewed(
						d,
						s,
						marks,
						{ kind: 'group', group: g.key },
						true,
						'sections'
					);
					if (result.ok) marks = result.value.marks;
				}
				const done = reviewProgress(d, s, marks, 'tests-separate');
				expect(done.overall.reviewedUnits).toBe(done.overall.units);
				expect(done.overall.reviewedSlices).toBe(done.overall.slices);
				for (const file of d.files) marks = unmark(d, s, marks, file.file.path);
				expect(marks.files.size).toBe(0);
			}),
			{ numRuns: 60 }
		);
	});
});

function unmark(d: Diff, s: AssignmentState, marks: ReviewedMarks, p: RepoPath): ReviewedMarks {
	const result = markReviewed(d, s, marks, { kind: 'file', path: p }, false, 'sections');
	return result.ok ? result.value.marks : marks;
}
