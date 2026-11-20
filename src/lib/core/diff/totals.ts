import { addUnits, NO_UNITS, ONE_UNIT, unitCountOf, type UnitCount } from '../unit-count.tiny.ts';
import type { Diff } from './diff.ts';
import { fileAssignment, type Assignment, type AssignmentState } from './state.ts';

/** Calls `visit` with each run of units that share an assignment, and its size. */
export function forEachRun(
	diff: Diff,
	state: AssignmentState,
	visit: (assignment: Assignment, units: UnitCount) => void
): void {
	for (const file of diff.files) {
		const assignment = fileAssignment(state, file);
		switch (assignment.kind) {
			case 'file':
				visit(assignment.assignment, ONE_UNIT);
				break;
			case 'lines':
				for (const map of [assignment.old, assignment.new]) {
					for (const segment of map.segments) {
						visit(segment.value, unitCountOf(segment.last - segment.first + 1));
					}
				}
				break;
		}
	}
}

/** How many units of the diff no one has assigned. */
export function countUncategorised(diff: Diff, state: AssignmentState): UnitCount {
	let count = NO_UNITS;
	forEachRun(diff, state, (assignment, units) => {
		if (assignment.bucket.kind === 'uncategorised') count = addUnits(count, units);
	});
	return count;
}
