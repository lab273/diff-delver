import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	arbitraryAssignRequest,
	arbitraryAssignScenario,
	syntheticDiff
} from '../../../../tests/support/synthetic-diff.ts';
import { assign } from '../diff/assign.ts';
import type { Diff } from '../diff/diff.ts';
import { groupKeyId, type ViewKind } from '../diff/slices.ts';
import { initialState, type AssignmentState } from '../diff/state.ts';
import { EMPTY_UNIT_SET } from '../diff/unit-set.ts';
import { RangeSet } from '../range-set.ts';
import { markReviewed } from '../review/mark-reviewed.ts';
import { reviewProgress } from '../review/progress.ts';
import { NO_MARKS } from '../review/reviewed-marks.ts';
import { parseSectionId, type SectionId } from '../section-id.tiny.ts';
import { frameOf, type PartMarks } from '../viewer/parts.ts';
import {
	asUnitSets,
	describeStepProblem,
	effectiveOrders,
	fromUnitSets,
	MAX_STEPS,
	orderSection,
	StepLookup,
	type ReadingOrders,
	type StepRequest
} from './reading-order.ts';

function id(text: string): SectionId {
	const parsed = parseSectionId(text);
	if (!parsed.ok) throw new Error(text);
	return parsed.value;
}

const ALPHA = id('alpha');
const NOTHING: PartMarks = { reviewed: NO_MARKS, fresh: EMPTY_UNIT_SET, unmarked: EMPTY_UNIT_SET };

const diff = syntheticDiff([
	{ path: 'src/a.ts', change: 'added', lines: 4 },
	{
		path: 'src/b.ts',
		change: 'modified',
		hunks: [
			{ gap: 0, lines: [' ', '+', '+', ' '] },
			{ gap: 4, lines: [' ', '-', '+', ' '] }
		]
	},
	{ path: 'src/c.ts', change: 'added', lines: 2 }
]);

/** Every unit in `alpha`, except c.ts, which is left unsorted. */
const sorted = assign(diff, initialState(diff), [
	{ file: 'src/a.ts', section: 'alpha' },
	{ file: 'src/b.ts', section: 'alpha' }
]).state;

function ordered(state: AssignmentState, requests: readonly StepRequest[]): ReadingOrders {
	const steps = orderSection(diff, state, ALPHA, requests);
	if (!steps.ok) throw new Error(steps.error.map(describeStepProblem).join(' '));
	return new Map([[ALPHA, steps.value]]);
}

/** The added lines of b.ts's second hunk, as `lines`. */
function secondHunkOfB(): string {
	const file = diff.files.find((f) => f.file.path === 'src/b.ts');
	const added = file?.changed.new.intervals.at(-1);
	if (added === undefined) throw new Error('b.ts has no added lines');
	return `+${String(added.last)}`;
}

describe('a section’s reading order', () => {
	it('reads the steps first, a file over two steps, then what no step names in path order', () => {
		const orders = ordered(sorted, [
			{ file: 'src/b.ts', lines: secondHunkOfB(), note: 'The call that changed.' },
			{ file: 'src/a.ts' },
			{ file: 'src/b.ts', note: 'The rest of it.' }
		]);
		const frame = frameOf(diff, sorted, NOTHING, 'sections', [ALPHA], new StepLookup(orders));
		const alpha = frame.groups.find((g) => groupKeyId(g.key) === 'section:alpha');
		expect(
			alpha?.parts.map((p) => [
				p.file.file.path,
				p.step,
				p.note,
				p.tally.units,
				`${p.position}/${p.of}`
			])
		).toEqual([
			['src/b.ts', 1, 'The call that changed.', 1, '1/2'],
			['src/a.ts', 2, undefined, 4, '1/1'],
			['src/b.ts', 3, 'The rest of it.', 3, '2/2']
		]);
		expect(alpha?.parts[0]?.steps).toBe(3);
		// Another step's lines are no group of their own: the file names only other groups.
		expect(alpha?.parts[0]?.others).toEqual([]);
	});

	it('puts lines no step names after the steps, in path order', () => {
		const orders = ordered(sorted, [{ file: 'src/b.ts', lines: secondHunkOfB() }]);
		const frame = frameOf(diff, sorted, NOTHING, 'sections', [ALPHA], new StepLookup(orders));
		const alpha = frame.groups.find((g) => groupKeyId(g.key) === 'section:alpha');
		expect(alpha?.parts.map((p) => [p.file.file.path, p.step])).toEqual([
			['src/b.ts', 1],
			['src/a.ts', undefined],
			['src/b.ts', undefined]
		]);
	});

	it('refuses a step outside the section, one an earlier step has, a long note and too many steps', () => {
		const refused = orderSection(diff, sorted, ALPHA, [
			{ file: 'src/c.ts' },
			{ file: 'src/a.ts' },
			{ file: 'src/a.ts', lines: '+1..+2' },
			{ file: 'src/b.ts', note: 'x'.repeat(301) }
		]);
		expect(refused.ok ? [] : refused.error.map((p) => p.kind)).toEqual([
			'StepOutsideSection',
			'StepAlreadyTaken',
			'InvalidStepNote'
		]);
		const many = orderSection(
			diff,
			sorted,
			ALPHA,
			Array.from({ length: MAX_STEPS + 1 }, () => ({ file: 'src/a.ts' }))
		);
		expect(many.ok ? '' : many.error[0]?.kind).toBe('TooManySteps');
	});

	it('drops a step whose lines left the section, and carries steps through their unit sets', () => {
		const orders = ordered(sorted, [{ file: 'src/a.ts' }, { file: 'src/b.ts' }]);
		const moved = assign(diff, sorted, [
			{ file: 'src/a.ts', lines: '+1..+4', section: 'beta' }
		]).state;
		expect([...(effectiveOrders(diff, moved, orders).get(ALPHA) ?? [])].map((s) => s.path)).toEqual(
			['src/b.ts']
		);
		// Carried as they are, the steps come back the same; a set left out drops its step.
		const sets = asUnitSets(orders);
		expect(fromUnitSets(orders, sets)).toEqual(orders);
		const fewer = new Map([...sets].slice(1));
		expect([...(fromUnitSets(orders, fewer).get(ALPHA) ?? [])].map((s) => s.path)).toEqual([
			'src/b.ts'
		]);
	});

	it('puts every unit of a section in exactly one part, and a part’s tick marks exactly its units', () => {
		const scenario = arbitraryAssignScenario.chain(([d, calls]) =>
			fc.tuple(
				fc.constant(d),
				fc.constant(calls),
				fc.array(arbitraryAssignRequest(d), { maxLength: 5 }),
				fc.array(arbitraryAssignRequest(d), { maxLength: 2 })
			)
		);
		fc.assert(
			fc.property(scenario, ([d, calls, stepItems, later]) => {
				let state = initialState(d);
				for (const call of calls) state = assign(d, state, call).state;
				const requests: StepRequest[] = stepItems.flatMap((item) =>
					item.file === undefined
						? []
						: [
								item.lines === undefined
									? { file: item.file }
									: { file: item.file, lines: item.lines }
							]
				);
				// Keep only the steps the section can take, as an agent would after a refusal.
				const steps: StepRequest[] = [];
				for (const request of requests) {
					if (orderSection(d, state, ALPHA, [...steps, request]).ok) steps.push(request);
				}
				const stored = ordered2(d, state, steps);
				// A later `assign` may move lines out of the section; the order still holds.
				for (const item of later) state = assign(d, state, [item]).state;
				checkPartition(d, state, effectiveOrders(d, state, stored));
			})
		);
	});
});

function ordered2(
	d: Diff,
	state: AssignmentState,
	requests: readonly StepRequest[]
): ReadingOrders {
	const steps = orderSection(d, state, ALPHA, requests);
	if (!steps.ok) throw new Error(steps.error.map(describeStepProblem).join(' '));
	return steps.value.length === 0 ? new Map() : new Map([[ALPHA, steps.value]]);
}

function checkPartition(d: Diff, state: AssignmentState, orders: ReadingOrders): void {
	const lookup = new StepLookup(orders);
	const views: readonly ViewKind[] = ['sections', 'tests-separate'];
	for (const view of views) {
		const frame = frameOf(d, state, NOTHING, view, [ALPHA], lookup);
		const progress = reviewProgress(d, state, NO_MARKS, view, [ALPHA]);
		// Every group's parts hold its units once: their sum is the group's count.
		for (const group of frame.groups) {
			const counted = progress.groups.get(groupKeyId(group.key))?.tally.units ?? 0;
			expect(group.tally.units).toBe(counted);
		}
		// Ticking a part marks exactly its units, and no two parts share one.
		let marks = NO_MARKS;
		let total = 0;
		for (const group of frame.groups) {
			for (const part of group.parts) {
				const marked = markReviewed(
					d,
					state,
					marks,
					{ kind: 'slice', group: part.group, path: part.file.file.path, step: part.step },
					true,
					view,
					lookup
				);
				expect(marked.ok ? marked.value.units : 0).toBe(part.tally.units);
				if (marked.ok) marks = marked.value.marks;
				total += part.tally.units;
			}
		}
		const all = frameOf(d, state, { ...NOTHING, reviewed: marks }, view, [ALPHA], lookup);
		expect(all.overall.reviewed + all.ignored.reviewed).toBe(total);
	}
	// Steps never overlap.
	const steps = orders.get(ALPHA) ?? [];
	const seen = new Map<string, { old: RangeSet; new: RangeSet; file: boolean }>();
	for (const step of steps) {
		const before = seen.get(step.path) ?? { old: RangeSet.empty, new: RangeSet.empty, file: false };
		expect(before.old.intersect(step.units.old).isEmpty).toBe(true);
		expect(before.new.intersect(step.units.new).isEmpty).toBe(true);
		expect(before.file && step.units.file).toBe(false);
		seen.set(step.path, {
			old: before.old.union(step.units.old),
			new: before.new.union(step.units.new),
			file: before.file || step.units.file
		});
	}
}
