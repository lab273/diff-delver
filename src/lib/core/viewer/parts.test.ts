import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	arbitraryAssignScenario,
	marksFrom,
	syntheticDiff
} from '../../../../tests/support/synthetic-diff.ts';
import { assign } from '../diff/assign.ts';
import { autoIgnore } from '../diff/auto-ignore.ts';
import { groupKeyId, type GroupKey, type ViewKind } from '../diff/slices.ts';
import { initialState, type AssignmentState } from '../diff/state.ts';
import { EMPTY_UNIT_SET } from '../diff/unit-set.ts';
import { reviewProgress } from '../review/progress.ts';
import { NO_MARKS } from '../review/reviewed-marks.ts';
import { parseSectionId, type SectionId } from '../section-id.tiny.ts';
import { frameOf, needsReview, type Frame, type PartMarks } from './parts.ts';

function id(text: string): SectionId {
	const parsed = parseSectionId(text);
	if (!parsed.ok) throw new Error(text);
	return parsed.value;
}

const NOTHING: PartMarks = { reviewed: NO_MARKS, fresh: EMPTY_UNIT_SET, unmarked: EMPTY_UNIT_SET };

const diff = syntheticDiff([
	{ path: 'assets/logo.png', change: 'binary' },
	{ path: 'pnpm-lock.yaml', change: 'added', lines: 3 },
	{
		path: 'src/app.ts',
		change: 'modified',
		hunks: [
			{ gap: 0, lines: [' ', '-', '-', '+', '+', '+', ' '] },
			{ gap: 4, lines: [' ', '+', ' '] }
		]
	}
]);

function named(key: GroupKey): string {
	return groupKeyId(key);
}

function shape(frame: Frame): unknown {
	return frame.groups.map((g) => [
		named(g.key),
		g.parts.map((p) => [p.file.file.path, p.change, p.added, p.removed, `${p.position}/${p.of}`])
	]);
}

describe('the frame', () => {
	it('lists every part under Not sorted yet when nothing is sorted, with the lockfile under Ignored', () => {
		const state = autoIgnore(diff, initialState(diff)).state;
		const frame = frameOf(diff, state, NOTHING, 'sections', []);
		expect(shape(frame)).toEqual([
			['ignored', [['pnpm-lock.yaml', 'added', 3, 0, '1/1']]],
			[
				'uncategorised',
				[
					['assets/logo.png', 'changed, binary file', 0, 0, '1/1'],
					['src/app.ts', 'changed', 4, 2, '1/1']
				]
			]
		]);
		expect(frame.groups[0]?.parts[0]?.ignored).toEqual([{ kind: 'stated', text: 'Lockfile' }]);
		// The image is one change, the change to the file itself.
		expect(frame.groups[1]?.parts[0]?.fileUnit).toBe('changed, binary file');
		expect(frame.overall.units).toBe(7);
		expect(frame.ignored.units).toBe(3);
		expect(frame.files.map((f) => [f.file.file.path, f.tally.units, f.ignored])).toEqual([
			['assets/logo.png', 1, 0],
			['pnpm-lock.yaml', 0, 3],
			['src/app.ts', 6, 0]
		]);
	});

	it('numbers a file split between groups, part 1 of 2 and 2 of 2, each naming the other', () => {
		const state = assign(diff, initialState(diff), [
			{ file: 'src/app.ts', lines: '-2..-3,+2', section: 'alpha' },
			{ file: 'assets/logo.png', section: 'ignored', reason: 'Re-exported by the build' }
		]).state;
		const frame = frameOf(diff, state, NOTHING, 'sections', [id('alpha'), id('empty')]);
		expect(shape(frame)).toEqual([
			['section:alpha', [['src/app.ts', 'changed', 1, 2, '1/2']]],
			// A section is listed even when nothing is in it.
			['section:empty', []],
			['ignored', [['assets/logo.png', 'changed, binary file', 0, 0, '1/1']]],
			[
				'uncategorised',
				[
					['pnpm-lock.yaml', 'added', 3, 0, '1/1'],
					['src/app.ts', 'changed', 3, 0, '2/2']
				]
			]
		]);
		expect(frame.groups[0]?.parts[0]?.others.map(named)).toEqual(['uncategorised']);
		expect(frame.groups[2]?.parts[0]?.ignored).toEqual([
			{ kind: 'agent', reason: 'Re-exported by the build' }
		]);
	});

	it('says in each part only what waits there, when a file’s lines and the change to the file itself are apart', () => {
		const run = syntheticDiff([
			{
				path: 'run.sh',
				change: 'modified',
				executable: true,
				hunks: [{ gap: 0, lines: [' ', '-', '+', ' '] }]
			}
		]);
		const parts = (state: AssignmentState) =>
			frameOf(run, state, NOTHING, 'sections', [id('alpha')]).groups.flatMap((g) =>
				g.parts.map((p) => [named(g.key), p.change, p.fileUnit, p.tally.units])
			);
		expect(parts(initialState(run))).toEqual([
			['uncategorised', 'changed, made executable', 'made executable', 3]
		]);
		const apart = assign(run, initialState(run), [
			{ file: 'run.sh', lines: 'file', section: 'alpha' }
		]).state;
		expect(parts(apart)).toEqual([
			['section:alpha', 'made executable', 'made executable', 1],
			['uncategorised', 'changed', undefined, 2]
		]);
	});

	it('counts what is new and what an update unmarked, and the unmarked only while unmarked', () => {
		const state = initialState(diff);
		const app = diff.files[2];
		if (app === undefined) throw new Error('src/app.ts');
		const every = marksFrom(diff, [true]);
		const marks: PartMarks = {
			reviewed: { files: new Map([...every.files].filter(([p]) => p !== app.file.path)) },
			fresh: { files: new Map([...every.files].filter(([p]) => p === app.file.path)) },
			unmarked: every
		};
		const parts = frameOf(diff, state, marks, 'sections', []).groups.flatMap((g) => g.parts);
		expect(parts.map((p) => [p.file.file.path, p.tally])).toEqual([
			['assets/logo.png', { units: 1, reviewed: 1, fresh: 0, unmarked: 0 }],
			['pnpm-lock.yaml', { units: 3, reviewed: 3, fresh: 0, unmarked: 0 }],
			['src/app.ts', { units: 6, reviewed: 0, fresh: 6, unmarked: 6 }]
		]);
		expect(parts.map(needsReview)).toEqual([false, false, true]);
	});

	it('agrees with the stored progress, and the by-file view with the groups, for any state and marks', () => {
		fc.assert(
			fc.property(
				arbitraryAssignScenario,
				fc.array(fc.boolean(), { minLength: 1, maxLength: 32 }),
				fc.constantFrom<ViewKind>('sections', 'tests-separate'),
				([d, calls], flags, view) => {
					let s = initialState(d);
					for (const call of calls) s = assign(d, s, call).state;
					const reviewed = marksFrom(d, flags);
					const marks: PartMarks = { reviewed, fresh: EMPTY_UNIT_SET, unmarked: EMPTY_UNIT_SET };
					const frame = frameOf(d, s, marks, view, [id('alpha'), id('beta')]);
					const progress = reviewProgress(d, s, reviewed, view, [id('alpha'), id('beta')]);
					expect([frame.overall.units, frame.overall.reviewed]).toEqual([
						progress.overall.units,
						progress.overall.reviewedUnits
					]);
					expect(frame.ignored.units).toBe(progress.ignored.units);
					// Every group's tally is its parts', and the progress's, in the same order.
					const withParts = frame.groups.filter((g) => g.parts.length > 0);
					expect(withParts.map((g) => [named(g.key), g.tally.units, g.tally.reviewed])).toEqual(
						[...progress.groups.values()].map((g) => [
							named(g.key),
							g.tally.units,
							g.tally.reviewedUnits
						])
					);
					// Each file once, in the diff's order, with the same parts as the groups hold.
					expect(frame.files.map((f) => f.file.file.path)).toEqual(d.files.map((f) => f.file.path));
					const byFile = frame.files.flatMap((f) =>
						f.parts.map((p) => `${named(p.group)} ${p.file.file.path}`)
					);
					const byGroup = frame.groups.flatMap((g) =>
						g.parts.map((p) => `${named(g.key)} ${p.file.file.path}`)
					);
					expect([...byFile].sort()).toEqual([...byGroup].sort());
					for (const f of frame.files) {
						expect(f.tally.units + f.ignored).toBe(d.byPath.get(f.file.file.path)?.unitCount);
						expect(f.tally.units).toBe(progress.files.get(f.file.file.path)?.tally.units);
					}
				}
			),
			{ numRuns: 150 }
		);
	});
});
