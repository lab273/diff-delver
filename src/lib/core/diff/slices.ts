/**
 * Slices (DESIGN 4.3): what the reviewer sees and ticks. A slice is one file's
 * change units within one group, drawn as that file's hunks with every line
 * classified, so the file always reads correctly:
 *
 * - context lines,
 * - this slice's own changes,
 * - changes that live in another group, shown muted with a link to it.
 *
 * A hunk appears in a slice only if it holds at least one of the slice's own
 * units. A file's file-level unit (a change to its name, mode or kind, or the
 * whole change of a file with no lines) is in the slice of the group its own
 * bucket puts it in, at the top of that slice; when no lines of the file are in
 * that group, the slice holds the file-level unit alone. So a file split
 * across sections shows its file-level change in exactly one of its parts.
 *
 * Two views project the same state into groups, and neither changes it
 * (DESIGN 4.4): `sectionView` puts every unit in its bucket's group;
 * `testsSeparateView` lifts the test and snapshot units of each section into a
 * Tests group of its own, sub-grouped by section.
 */
import { groupKeyId, type GroupKeyId } from '../group-key-id.tiny.ts';
import type { SectionId } from '../section-id.tiny.ts';
import { addUnits, NO_UNITS, ONE_UNIT, type UnitCount } from '../unit-count.tiny.ts';
import type { Side } from '../side.tiny.ts';
import type { Diff, DiffFile } from './diff.ts';
import type { AddedLine, ContextLine, DeletedLine, FileDiff, Hunk } from './file-diff.ts';
import { fileAssignment, type Assignment, type AssignmentState } from './state.ts';

export { groupKeyId };

/** A group of slices in a view. */
export type GroupKey =
	| { readonly kind: 'section'; readonly section: SectionId }
	/** In the tests-separate view: the test and snapshot units of one section. */
	| { readonly kind: 'tests'; readonly section: SectionId }
	| { readonly kind: 'ignored' }
	| { readonly kind: 'uncategorised' };

export type SliceLine =
	| { readonly kind: 'context'; readonly line: ContextLine }
	| {
			/** One of this slice's own units. */
			readonly kind: 'own';
			readonly line: AddedLine | DeletedLine;
			readonly assignment: Assignment;
	  }
	| {
			/** A change that belongs to another group; it does not count towards this slice. */
			readonly kind: 'elsewhere';
			readonly line: AddedLine | DeletedLine;
			readonly assignment: Assignment;
			readonly group: GroupKey;
	  };

export interface SliceHunk {
	readonly hunk: Hunk;
	readonly lines: readonly SliceLine[];
}

export interface Slice {
	readonly file: FileDiff;
	/** The file-level unit's assignment, when that unit is in this slice. */
	readonly fileUnit: Assignment | undefined;
	/** The hunks holding at least one of this slice's own lines. */
	readonly hunks: readonly SliceHunk[];
	/** This slice's own units. */
	readonly units: UnitCount;
}

export interface Group {
	readonly key: GroupKey;
	/** In the diff's file order. */
	readonly slices: readonly Slice[];
	readonly units: UnitCount;
}

/**
 * Every group of a view in reading order (DESIGN 8.2): the sections in the order
 * given (then any others the state uses, in file order), in the tests-separate
 * view the non-empty test groups in the same order, then Uncategorised, which
 * still needs reading, and last Ignored, which does not.
 * Sections are listed even when empty; test groups only when not.
 */
export interface View {
	readonly groups: readonly Group[];
}

/** Every unit where it was assigned. */
export function sectionView(
	diff: Diff,
	state: AssignmentState,
	sections: readonly SectionId[] = []
): View {
	return project(diff, state, sections, bucketGroup, false);
}

/** Test and snapshot units of each section lifted into a Tests group. Assignments do not change. */
export function testsSeparateView(
	diff: Diff,
	state: AssignmentState,
	sections: readonly SectionId[] = []
): View {
	return project(diff, state, sections, testsSeparateGroup, true);
}

/** The reviewer's two ways of grouping tests (DESIGN 4.4): with their section, or separate. */
export type ViewKind = 'sections' | 'tests-separate';

/** The group a unit with this assignment is in, in a view. */
export function groupOf(view: ViewKind, assignment: Assignment): GroupKey {
	switch (view) {
		case 'sections':
			return bucketGroup(assignment);
		case 'tests-separate':
			return testsSeparateGroup(assignment);
	}
}

function bucketGroup(assignment: Assignment): GroupKey {
	switch (assignment.bucket.kind) {
		case 'section':
			return { kind: 'section', section: assignment.bucket.section };
		case 'ignored':
			return { kind: 'ignored' };
		case 'uncategorised':
			return { kind: 'uncategorised' };
	}
}

function testsSeparateGroup(assignment: Assignment): GroupKey {
	const group = bucketGroup(assignment);
	return group.kind === 'section' && assignment.role !== 'code'
		? { kind: 'tests', section: group.section }
		: group;
}

interface Building {
	readonly key: GroupKey;
	readonly slices: Slice[];
	units: UnitCount;
}

/**
 * Groups in reading order (see `View`): the sections in the order given, then
 * any others in the order they come in `items`, then the test groups in the
 * same section order, then Uncategorised and Ignored. `items` in file order
 * gives the order the views show.
 */
export function inReadingOrder<T>(
	items: readonly T[],
	keyOf: (item: T) => GroupKey,
	sections: readonly SectionId[]
): T[] {
	const sectionOrder = new Map<SectionId, number>();
	const see = (section: SectionId): void => {
		if (!sectionOrder.has(section)) sectionOrder.set(section, sectionOrder.size);
	};
	for (const section of sections) see(section);
	for (const item of items) {
		const key = keyOf(item);
		if (key.kind === 'section') see(key.section);
	}
	for (const item of items) {
		const key = keyOf(item);
		if (key.kind === 'tests') see(key.section);
	}
	const rank = (key: GroupKey): number => {
		switch (key.kind) {
			case 'section':
				return sectionOrder.get(key.section) ?? 0;
			case 'tests':
				return sectionOrder.size + (sectionOrder.get(key.section) ?? 0);
			case 'uncategorised':
				return 2 * sectionOrder.size;
			case 'ignored':
				return 2 * sectionOrder.size + 1;
		}
	};
	return [...items].sort((a, b) => rank(keyOf(a)) - rank(keyOf(b)));
}

function project(
	diff: Diff,
	state: AssignmentState,
	sections: readonly SectionId[],
	groupOf: (assignment: Assignment) => GroupKey,
	withTests: boolean
): View {
	const groups = new Map<GroupKeyId, Building>();
	const ensure = (key: GroupKey): Building => {
		const id = groupKeyId(key);
		let group = groups.get(id);
		if (group === undefined) {
			group = { key, slices: [], units: NO_UNITS };
			groups.set(id, group);
		}
		return group;
	};
	for (const section of sections) ensure({ kind: 'section', section });

	for (const file of diff.files) {
		for (const slice of slicesOfFile(file, state, groupOf)) {
			const group = ensure(slice.group);
			group.slices.push(slice.slice);
			group.units = addUnits(group.units, slice.slice.units);
		}
	}

	ensure({ kind: 'ignored' });
	ensure({ kind: 'uncategorised' });
	const ordered = inReadingOrder(
		[...groups.values()].filter((g) => withTests || g.key.kind !== 'tests'),
		(g) => g.key,
		sections
	);
	return { groups: ordered.map((g) => ({ key: g.key, slices: g.slices, units: g.units })) };
}

/** One file's slices in a view, each with its group, in the order its units come (not reading order). */
export function fileSlices(
	file: DiffFile,
	state: AssignmentState,
	view: ViewKind
): readonly { readonly group: GroupKey; readonly slice: Slice }[] {
	return slicesOfFile(file, state, (assignment) => groupOf(view, assignment));
}

/** The slices of one file, each with the group it belongs to. */
function slicesOfFile(
	file: DiffFile,
	state: AssignmentState,
	groupOf: (assignment: Assignment) => GroupKey
): readonly { readonly group: GroupKey; readonly slice: Slice }[] {
	const assignment = fileAssignment(state, file);
	const assignmentAt = (side: Side, line: number): Assignment => {
		const found = (side === 'old' ? assignment.old : assignment.new).get(line);
		if (found === undefined) throw new Error(`No assignment for a changed line ${side} ${line}`);
		return found;
	};
	const byGroup = new Map<
		GroupKeyId,
		{ group: GroupKey; fileUnit: Assignment | undefined; hunks: SliceHunk[]; units: UnitCount }
	>();
	const entryFor = (group: GroupKey, id: GroupKeyId) => {
		let entry = byGroup.get(id);
		if (entry === undefined) {
			entry = { group, fileUnit: undefined, hunks: [], units: NO_UNITS };
			byGroup.set(id, entry);
		}
		return entry;
	};
	if (assignment.file !== undefined) {
		const group = groupOf(assignment.file);
		const entry = entryFor(group, groupKeyId(group));
		entry.fileUnit = assignment.file;
		entry.units = ONE_UNIT;
	}
	// For each hunk: its classified lines, once per group that owns any of them.
	for (const hunk of file.hunks.values()) {
		const owners = new Map<GroupKeyId, GroupKey>();
		const classified = hunk.lines.map((line): Classified => {
			if (line.kind === 'context') return { kind: 'context', line };
			const a =
				line.kind === 'added' ? assignmentAt('new', line.new) : assignmentAt('old', line.old);
			const group = groupOf(a);
			const id = groupKeyId(group);
			owners.set(id, group);
			return { kind: 'change', line, assignment: a, group, id };
		});
		for (const [id, group] of owners) {
			let units = NO_UNITS;
			const lines = classified.map((c): SliceLine => {
				switch (c.kind) {
					case 'context':
						return c;
					case 'change':
						if (c.id !== id) {
							return { kind: 'elsewhere', line: c.line, assignment: c.assignment, group: c.group };
						}
						units = addUnits(units, ONE_UNIT);
						return { kind: 'own', line: c.line, assignment: c.assignment };
				}
			});
			const entry = entryFor(group, id);
			entry.hunks.push({ hunk, lines });
			entry.units = addUnits(entry.units, units);
		}
	}
	return [...byGroup.values()].map((entry) => ({
		group: entry.group,
		slice: { file: file.file, fileUnit: entry.fileUnit, hunks: entry.hunks, units: entry.units }
	}));
}

type Classified =
	| { readonly kind: 'context'; readonly line: ContextLine }
	| {
			readonly kind: 'change';
			readonly line: AddedLine | DeletedLine;
			readonly assignment: Assignment;
			readonly group: GroupKey;
			readonly id: GroupKeyId;
	  };
