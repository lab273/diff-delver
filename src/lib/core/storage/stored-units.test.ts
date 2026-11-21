import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	arbitraryAssignScenario,
	marksFrom,
	syntheticDiff
} from '../../../../tests/support/synthetic-diff.ts';
import { assign } from '../diff/assign.ts';
import type { Diff } from '../diff/diff.ts';
import { initialState, type AssignmentState } from '../diff/state.ts';
import { parseLineRange } from '../line-range.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import { fileUnitReviewed, NO_MARKS, sameReviewedMarks } from '../review/reviewed-marks.ts';
import {
	assignmentRowsOf,
	assignmentStateFromRows,
	changedAssignmentPaths,
	describeStoredStateMismatch,
	pathsMissingFileUnit,
	reviewedMarksFromRows,
	reviewedRowsOf,
	sameAssignmentState,
	type AssignmentRow
} from './stored-units.ts';

function path(text: string): RepoPath {
	const parsed = parseRepoPath(text);
	if (!parsed.ok) throw new Error(text);
	return parsed.value;
}

const arbitraryMarks = arbitraryAssignScenario.chain(([d]) =>
	fc.tuple(fc.constant(d), fc.array(fc.boolean(), { minLength: 1, maxLength: 64 }))
);

function reached(
	d: Diff,
	calls: readonly (readonly Parameters<typeof assign>[2][number][])[]
): AssignmentState {
	let state = initialState(d);
	for (const call of calls) state = assign(d, state, call).state;
	return state;
}

describe('the assignment state as rows', () => {
	it('reads back as an equal state, for any state any sequence of assign calls reaches', () => {
		fc.assert(
			fc.property(arbitraryAssignScenario, ([d, calls]) => {
				const state = reached(d, calls);
				const back = assignmentStateFromRows(d, assignmentRowsOf(d, state));
				expect(back.ok).toBe(true);
				if (back.ok) {
					expect(sameAssignmentState(d, state, back.value)).toBe(true);
					expect(assignmentRowsOf(d, back.value)).toEqual(assignmentRowsOf(d, state));
				}
			}),
			{ numRuns: 150 }
		);
	});

	it('reads back in any order of rows', () => {
		fc.assert(
			fc.property(arbitraryAssignScenario, fc.nat(), ([d, calls], seed) => {
				const state = reached(d, calls);
				const rows = [...assignmentRowsOf(d, state)];
				const shuffled = rows
					.map((r, i) => ({ r, k: (i * 7919 + seed) % 104729 }))
					.sort((a, b) => a.k - b.k);
				const back = assignmentStateFromRows(
					d,
					shuffled.map((x) => x.r)
				);
				expect(back.ok && sameAssignmentState(d, state, back.value)).toBe(true);
			}),
			{ numRuns: 60 }
		);
	});

	it('finds exactly the files one call changed', () => {
		fc.assert(
			fc.property(arbitraryAssignScenario, ([d, calls]) => {
				let state = initialState(d);
				for (const call of calls) {
					const after = assign(d, state, call).state;
					const changed = changedAssignmentPaths(d, state, after);
					for (const file of d.files) {
						const p = file.file.path;
						const rowsOf = (s: AssignmentState) => assignmentRowsOf(d, s, new Set([p]));
						expect(changed.has(p)).toBe(
							JSON.stringify(rowsOf(state)) !== JSON.stringify(rowsOf(after))
						);
					}
					state = after;
				}
			}),
			{ numRuns: 60 }
		);
	});
});

describe('reviewed marks as rows', () => {
	it('read back as equal marks, for any marks', () => {
		fc.assert(
			fc.property(arbitraryMarks, ([d, flags]) => {
				const marks = marksFrom(d, flags);
				const back = reviewedMarksFromRows(d, reviewedRowsOf(marks));
				expect(back.ok && sameReviewedMarks(marks, back.value)).toBe(true);
			}),
			{ numRuns: 150 }
		);
	});

	it('are no rows when nothing is marked', () => {
		expect(reviewedRowsOf(NO_MARKS)).toEqual([]);
	});
});

// src/a.ts: -2, +2, +3; image.png: a binary file, one file-level unit.
const diff = syntheticDiff([
	{ path: 'image.png', change: 'binary' },
	{ path: 'src/a.ts', change: 'modified', hunks: [{ gap: 0, lines: [' ', '-', '+', '+', ' '] }] }
]);
const a = path('src/a.ts');
const image = path('image.png');

function lines(side: 'old' | 'new', first: number, last: number) {
	const range = parseLineRange(side, first, last);
	if (!range.ok) throw new Error('range');
	return { kind: 'lines' as const, range: range.value };
}

describe('rows that do not fit the diff', () => {
	const rows = assignmentRowsOf(diff, initialState(diff));
	const uncategorised = rows[0]?.assignment ?? { bucket: { kind: 'uncategorised' }, role: 'code' };

	it.each<[string, readonly AssignmentRow[], string]>([
		['a file is missing', rows.filter((r) => r.path !== image), 'missing'],
		[
			'a file is not in the diff',
			[...rows, { path: path('other.ts'), units: { kind: 'file' }, assignment: uncategorised }],
			'not-in-diff'
		],
		[
			'two rows cover one line',
			[...rows, { path: a, units: lines('new', 3, 3), assignment: uncategorised }],
			'overlap'
		],
		[
			'a line is not covered',
			rows.filter(
				(r) => !(r.path === a && r.units.kind === 'lines' && r.units.range.side === 'old')
			),
			'units-differ'
		],
		[
			'a row covers a context line',
			[
				...rows.filter((r) => r.path !== a),
				{ path: a, units: lines('old', 1, 2), assignment: uncategorised },
				{ path: a, units: lines('new', 2, 3), assignment: uncategorised }
			],
			'units-differ'
		],
		[
			'a file with lines has a file-level row',
			[
				...rows.filter((r) => r.path !== a),
				{ path: a, units: { kind: 'file' }, assignment: uncategorised }
			],
			'units-differ'
		]
	])('are refused when %s', (_, given, problem) => {
		const read = assignmentStateFromRows(diff, given);
		expect(read.ok).toBe(false);
		if (!read.ok) {
			expect(read.error.problem).toBe(problem);
			expect(describeStoredStateMismatch(read.error)).toMatch(
				/Delete the Delve from the list of Delves/
			);
		}
	});

	it('are refused for marks on lines that did not change', () => {
		const read = reviewedMarksFromRows(diff, [{ path: a, units: lines('new', 4, 4) }]);
		expect(read.ok ? undefined : read.error.problem).toBe('units-differ');
	});

	it('are refused for marks on a file the diff lacks, or twice on one unit', () => {
		const missing = reviewedMarksFromRows(diff, [{ path: path('x'), units: { kind: 'file' } }]);
		expect(missing.ok ? undefined : missing.error.problem).toBe('not-in-diff');
		const twice = reviewedMarksFromRows(diff, [
			{ path: a, units: lines('new', 2, 3) },
			{ path: a, units: lines('new', 3, 3) }
		]);
		expect(twice.ok ? undefined : twice.error.problem).toBe('overlap');
	});
});

describe('a file-level unit beside lines', () => {
	// run.sh: made executable and edited, -2 and +2 beside its file-level unit.
	const withMode = syntheticDiff([
		{
			path: 'run.sh',
			change: 'modified',
			executable: true,
			hunks: [{ gap: 0, lines: [' ', '-', '+', ' '] }]
		}
	]);
	const run = path('run.sh');
	const sorted = assign(withMode, initialState(withMode), [
		{ file: 'run.sh', section: 'scripts' }
	]).state;
	const rows = assignmentRowsOf(withMode, sorted);

	it('is a row of its own, read back with the lines', () => {
		expect(rows.map((r) => r.units.kind)).toEqual(['file', 'lines', 'lines']);
		const back = assignmentStateFromRows(withMode, rows);
		expect(back.ok && sameAssignmentState(withMode, sorted, back.value)).toBe(true);
	});

	it('is found missing when the rows predate it, and refused until it has a row', () => {
		const before = rows.filter((r) => r.units.kind !== 'file');
		expect([...pathsMissingFileUnit(withMode, before)]).toEqual([run]);
		expect(pathsMissingFileUnit(withMode, rows).size).toBe(0);
		// A file with no rows at all is damaged, not from before.
		expect(pathsMissingFileUnit(withMode, []).size).toBe(0);
		const back = assignmentStateFromRows(withMode, before);
		expect(back.ok ? undefined : back.error.problem).toBe('units-differ');
		// Its marks need no row: a unit with no mark is not reviewed.
		const marks = reviewedMarksFromRows(withMode, [{ path: run, units: lines('new', 2, 2) }]);
		expect(marks.ok && fileUnitReviewed(marks.value, run)).toBe(false);
	});

	it('is refused twice over, in the assignments or in the marks', () => {
		const twice = assignmentStateFromRows(
			withMode,
			[...rows, rows[0] ?? rows[1]].filter((r) => r !== undefined)
		);
		expect(twice.ok ? undefined : twice.error.problem).toBe('overlap');
		const marked = reviewedMarksFromRows(withMode, [
			{ path: run, units: { kind: 'file' } },
			{ path: run, units: { kind: 'file' } }
		]);
		expect(marked.ok ? undefined : marked.error.problem).toBe('overlap');
	});

	it('round-trips marks on it with or without its lines', () => {
		const marks = reviewedMarksFromRows(withMode, [
			{ path: run, units: { kind: 'file' } },
			{ path: run, units: lines('old', 2, 2) }
		]);
		if (!marks.ok) throw new Error(marks.error.problem);
		expect(fileUnitReviewed(marks.value, run)).toBe(true);
		const back = reviewedMarksFromRows(withMode, reviewedRowsOf(marks.value));
		expect(back.ok && sameReviewedMarks(marks.value, back.value)).toBe(true);
	});
});
