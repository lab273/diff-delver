import type { Diff } from './diff.ts';
import { fileAssignment, type Assignment, type AssignmentState } from './state.ts';

/** Calls `visit` with each run of units that share an assignment, and its size. */
export function forEachRun(
	diff: Diff,
	state: AssignmentState,
	visit: (assignment: Assignment, units: number) => void
): void {
	for (const file of diff.files) {
		const assignment = fileAssignment(state, file);
		switch (assignment.kind) {
			case 'file':
				visit(assignment.assignment, 1);
				break;
			case 'lines':
				for (const map of [assignment.old, assignment.new]) {
					for (const segment of map.segments) {
						visit(segment.value, segment.last - segment.first + 1);
					}
				}
				break;
		}
	}
}

/** How many units of the diff no one has assigned. */
export function countUncategorised(diff: Diff, state: AssignmentState): number {
	let count = 0;
	forEachRun(diff, state, (assignment, units) => {
		if (assignment.bucket.kind === 'uncategorised') count += units;
	});
	return count;
}
