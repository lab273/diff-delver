/**
 * Assignment state: for one diff, the bucket and role of every change unit
 * (DESIGN 4.1). Stored as line ranges per file and side, not one entry per line.
 * Immutable: `assign` and the other operations return a new state.
 */
import { ONE_UNIT, unitCountOf, type UnitCount } from '../unit-count.tiny.ts';
import { parseLineRange, type LineRange } from '../line-range.ts';
import { RangeMap } from '../range-map.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import type { Role } from '../role.tiny.ts';
import type { Side } from '../side.tiny.ts';
import { sameBucket, UNCATEGORISED, type Bucket } from './bucket.ts';
import type { Diff, DiffFile } from './diff.ts';
import { guessRole, type ProjectRoleRule } from './path-rules.ts';

export interface Assignment {
	readonly bucket: Bucket;
	readonly role: Role;
}

export function sameAssignment(a: Assignment, b: Assignment): boolean {
	return a.role === b.role && sameBucket(a.bucket, b.bucket);
}

/** The assignments of one file: per line and side, or of its single file-level unit. */
export type FileAssignment =
	| {
			readonly kind: 'lines';
			readonly old: RangeMap<Assignment>;
			readonly new: RangeMap<Assignment>;
	  }
	| { readonly kind: 'file'; readonly assignment: Assignment };

export interface AssignmentState {
	readonly files: ReadonlyMap<RepoPath, FileAssignment>;
}

/** Every unit uncategorised, with the role its file's path suggests. */
export function initialState(
	diff: Diff,
	projectRoleRules: readonly ProjectRoleRule[] = []
): AssignmentState {
	const files = new Map<RepoPath, FileAssignment>();
	for (const file of diff.files) {
		const assignment: Assignment = {
			bucket: UNCATEGORISED,
			role: guessRole(file.file.path, projectRoleRules)
		};
		files.set(file.file.path, uniformAssignment(file, assignment));
	}
	return { files };
}

function uniformAssignment(file: DiffFile, assignment: Assignment): FileAssignment {
	return file.hasLines
		? {
				kind: 'lines',
				old: RangeMap.uniform(file.changed.old, assignment, sameAssignment),
				new: RangeMap.uniform(file.changed.new, assignment, sameAssignment)
			}
		: { kind: 'file', assignment };
}

/** A run of units in one file that share an assignment. */
export type AssignedUnits =
	| { readonly kind: 'lines'; readonly range: LineRange; readonly assignment: Assignment }
	| { readonly kind: 'file'; readonly assignment: Assignment };

/** The number of units an `AssignedUnits` covers. */
export function unitsIn(units: AssignedUnits): UnitCount {
	switch (units.kind) {
		case 'lines':
			return unitCountOf(units.range.last - units.range.first + 1);
		case 'file':
			return ONE_UNIT;
	}
}

/**
 * Every unit of a file grouped into runs that share an assignment: old-side lines
 * first, then new-side lines, each in order. A file missing from the state (which
 * a state built for this diff never has) reads as uncategorised code.
 */
export function assignedUnits(state: AssignmentState, file: DiffFile): readonly AssignedUnits[] {
	const assignment = fileAssignment(state, file);
	switch (assignment.kind) {
		case 'file':
			return [{ kind: 'file', assignment: assignment.assignment }];
		case 'lines':
			return [
				...sideRuns('old', assignment.old.segments),
				...sideRuns('new', assignment.new.segments)
			];
	}
}

function sideRuns(
	side: Side,
	segments: RangeMap<Assignment>['segments']
): readonly AssignedUnits[] {
	return segments.map((segment) => {
		const range = parseLineRange(side, segment.first, segment.last);
		if (!range.ok) throw new RangeError(`Not line numbers: ${segment.first}..${segment.last}`);
		return { kind: 'lines', range: range.value, assignment: segment.value };
	});
}

/** The assignment of a file, read safely. */
export function fileAssignment(state: AssignmentState, file: DiffFile): FileAssignment {
	return (
		state.files.get(file.file.path) ??
		uniformAssignment(file, { bucket: UNCATEGORISED, role: 'code' })
	);
}

/** The side map of a lines assignment. */
export function sideMap(
	assignment: FileAssignment & { kind: 'lines' },
	side: Side
): RangeMap<Assignment> {
	switch (side) {
		case 'old':
			return assignment.old;
		case 'new':
			return assignment.new;
	}
}
