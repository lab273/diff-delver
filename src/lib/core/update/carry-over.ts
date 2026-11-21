/**
 * Carry-over (DESIGN 6.2): when a diff is updated, the new version keeps what
 * the reviewer and the agent did to the lines that are still the same.
 *
 * Given the previous version's diff, its assignment state and reviewed marks,
 * the new diff, and git's diffs from the previous version's trees to the new
 * ones (the two heads, and the two bases), it gives the new version's state and
 * marks, the units that are new since the previous version, and a summary.
 *
 * **The rule.** A change line of the new diff is the same as a change line of the
 * previous one when:
 *
 * 1. its line of the file is the same line, as git's diff between the two heads
 *    (for an added line) or between the two bases (for a deleted line) says: that
 *    diff leaves the line unchanged, in the same file or one it renamed, so its
 *    text is byte for byte the same and only edits elsewhere moved its number
 *    (`line-map.ts`); and
 * 2. that line was a change line of the same kind in the previous diff, in the
 *    file that is the same file: for an added line, the file at that head path;
 *    for a deleted line, the file with that base path whose head path is the same
 *    file's too, or which was deleted in both; and
 * 3. it is not a weak match on its own: a line with no letter or digit (a blank
 *    line, a lone brace) with only such lines between it and an edit git made
 *    next to it is matched only when another line on the same side of the same
 *    run of changed lines is matched too, and is not weak itself. git lines up
 *    such lines across unrelated code (the `}` of a deleted function with the `}`
 *    of a new one), so on their own they say nothing. The marks on such lines go
 *    by the distance rule below anyway; this keeps their sections and roles, so
 *    the brace of a new function is not left in the old function's section.
 *
 * A matched line keeps its bucket and role. Anything else is new: not sorted
 * yet, with the role its path suggests, not reviewed, and then the built-in
 * rules and patterns ignore what they cover, as in a first version.
 *
 * **Reviewed marks.** A matched line keeps its reviewed mark only when nothing
 * near it changed: no line within `MARK_DISTANCE` (three) lines of it is new in
 * this version, and git's diffs between the two versions' heads and between
 * their bases made no edit within that distance. Distance is counted in the
 * new diff as the reviewer reads it (`near-changes.ts`): the lines of one hunk
 * in git's order, context, deleted and added lines together, so the lines just
 * above and below a line are one away from it whichever side they are on. A
 * place where lines were removed lies between two shown lines and is one away
 * from each. An edit counts in the file it is now in, so a file renamed between
 * the versions is measured as it is now, and a rename alone is not an edit near
 * its lines. An edit counts wherever it falls among the shown lines, also on a
 * line shown for context; every unit of the previous version that is gone was
 * removed by such an edit, so its place is always among them. Lines in
 * different hunks are never near each other. File-level units are not lines of
 * a hunk and do not count: a file made executable keeps the marks on its lines.
 * So familiar lines that now sit inside changed code, such as an unchanged error
 * check under a replaced call, are read again in their new surroundings.
 *
 * A file-level unit (`file-unit.ts`: a change to the file's name, mode or kind,
 * or the whole change of a file with no lines) keeps its state when the file at
 * the same path had one and it stands for the same change: the same status, and
 * the same path and mode on each side; and, for a file with no lines, whose unit
 * stands for its content too, the same object on each side. So a file made
 * executable since the previous version has its file-level unit new, however
 * its lines carried over.
 *
 * When in doubt it leaves a line unreviewed: a false "reviewed" hides code from
 * the reviewer, a false "new" costs them a second look. So a line that moved
 * within a file is new where it is now, a file split into two has its moved
 * lines new in the second file, and a copy is new however alike.
 *
 * Sections are not decided here: the new version keeps every section of the
 * previous one, with its id, title, summary and place, even when it ends up
 * empty (the service copies them).
 *
 * Work is in proportion to the number of change lines, with a binary search
 * per line.
 */
import type { Diff, DiffFile, SideLines } from '../diff/diff.ts';
import type { DiffLine, FileDiff, FileVersion } from '../diff/file-diff.ts';
import { autoIgnore, type AutoIgnoreOptions } from '../diff/auto-ignore.ts';
import type { ProjectRoleRule } from '../diff/path-rules.ts';
import { RangeMap, type Segment } from '../range-map.ts';
import { RangeSet } from '../range-set.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import type { Side } from '../side.tiny.ts';
import {
	fileAssignment,
	initialState,
	sameAssignment,
	sideMap,
	type Assignment,
	type AssignmentState,
	type FileAssignment
} from '../diff/state.ts';
import {
	fileUnitsOf,
	fileUnitInSet,
	linesInSet,
	unitSetSize,
	type FileUnitSet,
	type UnitSet
} from '../diff/unit-set.ts';
import { fileCountOf } from '../file-count.tiny.ts';
import { addUnits, NO_UNITS, unitCountOf, type UnitCount } from '../unit-count.tiny.ts';
import type { ReviewedMarks } from '../review/reviewed-marks.ts';
import { TreeLineMap, type TreeChanges } from './line-map.ts';
import { lineCountOf, type LineCount } from '../line-count.tiny.ts';
import { editPlaces, linesNearChanges, NO_EDITS, type EditPlaces } from './near-changes.ts';
import type { UpdateSummary } from './update-summary.ts';

/**
 * How many shown lines away a new line or an edit still takes a reviewed mark
 * off a line (see the top of this file, and DESIGN 6.2 step 3).
 */
export const MARK_DISTANCE: LineCount = lineCountOf(3);

/** git's edits to each file, by the file's path in the later tree. */
function editsByPath(changes: TreeChanges): ReadonlyMap<RepoPath, FileDiff> {
	const byPath = new Map<RepoPath, FileDiff>();
	if (changes.kind === 'diff') {
		for (const file of changes.files) if (file.new !== undefined) byPath.set(file.new.path, file);
	}
	return byPath;
}

/** One version of a diff, with what was done to it. */
export interface DiffVersion {
	readonly diff: Diff;
	readonly state: AssignmentState;
	readonly marks: ReviewedMarks;
}

export interface CarryOverInput {
	readonly previous: DiffVersion;
	readonly diff: Diff;
	/** git's diff from the previous version's head tree to the new one's. */
	readonly heads: TreeChanges;
	/** git's diff from the previous version's base tree to the new one's. */
	readonly bases: TreeChanges;
	/** What the built-in rules need about the new diff, as for a first version. */
	readonly autoIgnore?: AutoIgnoreOptions;
	readonly projectRoleRules?: readonly ProjectRoleRule[];
}

export interface CarriedOver {
	readonly state: AssignmentState;
	readonly marks: ReviewedMarks;
	/** The units of the new diff with no match in the previous version. */
	readonly fresh: UnitSet;
	/**
	 * The units of the new diff that were reviewed in the previous version and
	 * matched, but lost their mark because something near them changed (the
	 * distance rule above), so the page can say why they are to be read again.
	 * Never fresh, never in `marks`.
	 */
	readonly unmarked: UnitSet;
	readonly summary: UpdateSummary;
}

/** The previous version's files, indexed for lookups by head path and by base path. */
interface PreviousFiles {
	readonly byNewPath: ReadonlyMap<RepoPath, DiffFile>;
	readonly byOldPath: ReadonlyMap<RepoPath, readonly DiffFile[]>;
}

function indexPrevious(diff: Diff): PreviousFiles {
	const byNewPath = new Map<RepoPath, DiffFile>();
	const byOldPath = new Map<RepoPath, DiffFile[]>();
	for (const file of diff.files) {
		if (file.file.new !== undefined) byNewPath.set(file.file.new.path, file);
		if (file.file.old !== undefined) {
			const list = byOldPath.get(file.file.old.path);
			if (list === undefined) byOldPath.set(file.file.old.path, [file]);
			else list.push(file);
		}
	}
	return { byNewPath, byOldPath };
}

/** A match for one change line: the previous file and the line's number there. */
interface Candidate {
	readonly previous: DiffFile;
	readonly line: number;
	/** Matched only by git's alignment, on a line with nothing to identify it. */
	readonly weak: boolean;
}

/** Sorted segments for one side, merged as they come. */
class SegmentsBuilder {
	readonly segments: Segment<Assignment>[] = [];

	add(line: number, value: Assignment): void {
		const last = this.segments.at(-1);
		if (last !== undefined && last.last + 1 === line && sameAssignment(last.value, value)) {
			this.segments[this.segments.length - 1] = {
				first: last.first,
				last: line,
				value: last.value
			};
		} else {
			this.segments.push({ first: line, last: line, value });
		}
	}
}

/** What one side of one new file came to. */
interface SideResult {
	readonly assignments: SegmentsBuilder;
	readonly reviewed: number[];
	readonly fresh: number[];
}

function newSide(): SideResult {
	return { assignments: new SegmentsBuilder(), reviewed: [], fresh: [] };
}

class CarryOver {
	readonly #input: CarryOverInput;
	readonly #heads: TreeLineMap;
	readonly #bases: TreeLineMap;
	readonly #previous: PreviousFiles;
	readonly #initial: AssignmentState;
	readonly #headEdits: ReadonlyMap<RepoPath, FileDiff>;
	readonly #baseEdits: ReadonlyMap<RepoPath, FileDiff>;
	/** Units of each previous file that were matched, by its path. */
	readonly #matched = new Map<RepoPath, number>();

	constructor(input: CarryOverInput) {
		this.#input = input;
		this.#heads = TreeLineMap.of(input.heads);
		this.#bases = TreeLineMap.of(input.bases);
		this.#previous = indexPrevious(input.previous.diff);
		this.#initial = initialState(input.diff, input.projectRoleRules);
		this.#headEdits = editsByPath(input.heads);
		this.#baseEdits = editsByPath(input.bases);
	}

	run(): CarriedOver {
		const files = new Map<RepoPath, FileAssignment>();
		const marks = new Map<RepoPath, FileUnitSet>();
		const fresh = new Map<RepoPath, FileUnitSet>();
		const unmarked = new Map<RepoPath, FileUnitSet>();
		const previousOf = new Map<RepoPath, DiffFile | undefined>();
		for (const file of this.#input.diff.files) {
			const path = file.file.path;
			const previous = this.#previousFile(file);
			previousOf.set(path, previous);
			const lines = this.#lines(file);
			const own = file.hasFileUnit ? this.#fileUnit(file) : undefined;
			files.set(path, { old: lines.old, new: lines.new, file: own?.assignment });
			const kept = this.#awayFromChanges(file, lines.reviewed, lines.fresh);
			const reviewed = fileUnitsOf(kept.old, kept.new, own?.reviewed ?? false);
			if (reviewed !== undefined) marks.set(path, reviewed);
			const lost = fileUnitsOf(
				lines.reviewed.old.subtract(kept.old),
				lines.reviewed.new.subtract(kept.new)
			);
			if (lost !== undefined) unmarked.set(path, lost);
			const isNew = fileUnitsOf(lines.fresh.old, lines.fresh.new, own?.fresh ?? false);
			if (isNew !== undefined) fresh.set(path, isNew);
		}
		const sorted = autoIgnore(this.#input.diff, { files }, this.#input.autoIgnore);
		const freshSet: UnitSet = { files: fresh };
		const marksSet: ReviewedMarks = { files: marks };
		return {
			state: sorted.state,
			marks: marksSet,
			fresh: freshSet,
			unmarked: { files: unmarked },
			summary: this.#summary(sorted.state, marksSet, freshSet, previousOf)
		};
	}

	/** The reviewed lines of a file without those near a change (see the top of this file). */
	#awayFromChanges(file: DiffFile, reviewed: SideLines, fresh: SideLines): SideLines {
		if (reviewed.old.isEmpty && reviewed.new.isEmpty) return reviewed;
		const edits = (byPath: ReadonlyMap<RepoPath, FileDiff>, path: RepoPath | undefined) => {
			const change = path === undefined ? undefined : byPath.get(path);
			return change === undefined ? NO_EDITS : editPlaces(change);
		};
		const heads: EditPlaces = edits(this.#headEdits, file.file.new?.path);
		const bases: EditPlaces = edits(this.#baseEdits, file.file.old?.path);
		const near = linesNearChanges({ file, fresh, heads, bases, distance: MARK_DISTANCE });
		return { old: reviewed.old.subtract(near.old), new: reviewed.new.subtract(near.new) };
	}

	/**
	 * The previous version's file that this one is, for the summary: the file at
	 * the head path it came from, or, for a deleted file, the deleted file at the
	 * base path it came from; and when its lines cannot be followed there (a file
	 * that became binary, or a deleted file that came back), the previous file at
	 * the same path, so one path is never counted as a new file and a gone one.
	 * Undefined when it is new to the diff.
	 */
	#previousFile(file: DiffFile): DiffFile | undefined {
		return this.#followedFile(file) ?? this.#input.previous.diff.byPath.get(file.file.path);
	}

	#followedFile(file: DiffFile): DiffFile | undefined {
		const now = file.file.new;
		if (now !== undefined) {
			const earlier = this.#heads.earlierPath(now.path);
			return earlier === undefined ? undefined : this.#previous.byNewPath.get(earlier);
		}
		const old = file.file.old;
		if (old === undefined) return undefined;
		const earlier = this.#bases.earlierPath(old.path);
		if (earlier === undefined) return undefined;
		return this.#previous.byOldPath.get(earlier)?.find((f) => f.file.new === undefined);
	}

	#count(previous: DiffFile, units: number): void {
		const path = previous.file.path;
		this.#matched.set(path, (this.#matched.get(path) ?? 0) + units);
	}

	/** The file-level unit of a file that has one: its assignment, and whether it is reviewed or new. */
	#fileUnit(file: DiffFile): { assignment: Assignment; reviewed: boolean; fresh: boolean } {
		const path = file.file.path;
		const previous = this.#input.previous.diff.byPath.get(path);
		const before =
			previous === undefined || !sameFileUnit(previous, file)
				? undefined
				: fileAssignment(this.#input.previous.state, previous).file;
		if (previous !== undefined && before !== undefined) {
			this.#count(previous, 1);
			return {
				assignment: before,
				reviewed: fileUnitInSet(this.#input.previous.marks, path),
				fresh: false
			};
		}
		const initial = fileAssignment(this.#initial, file).file;
		if (initial === undefined) throw new Error('A file with a file-level unit has its assignment.');
		return { assignment: initial, reviewed: false, fresh: true };
	}

	/** The lines of a file: their assignments, and which are reviewed and which new. */
	#lines(file: DiffFile): {
		old: RangeMap<Assignment>;
		new: RangeMap<Assignment>;
		reviewed: SideLines;
		fresh: SideLines;
	} {
		const initial = fileAssignment(this.#initial, file);
		const sides: Record<Side, SideResult> = { old: newSide(), new: newSide() };
		const content = file.file.content;
		if (content.kind === 'text') {
			for (const hunk of content.hunks) {
				let run: DiffLine[] = [];
				for (const line of hunk.lines) {
					if (line.kind === 'context') {
						this.#run(file, run, initial, sides);
						run = [];
					} else run.push(line);
				}
				this.#run(file, run, initial, sides);
			}
		}
		return {
			old: RangeMap.fromSegments(sides.old.assignments.segments, sameAssignment),
			new: RangeMap.fromSegments(sides.new.assignments.segments, sameAssignment),
			reviewed: {
				old: RangeSet.fromNumbers(sides.old.reviewed),
				new: RangeSet.fromNumbers(sides.new.reviewed)
			},
			fresh: {
				old: RangeSet.fromNumbers(sides.old.fresh),
				new: RangeSet.fromNumbers(sides.new.fresh)
			}
		};
	}

	/** One run of changed lines between context lines: matches each, then keeps the strong ones. */
	#run(
		file: DiffFile,
		run: readonly DiffLine[],
		initial: FileAssignment,
		sides: Record<Side, SideResult>
	): void {
		if (run.length === 0) return;
		const candidates: (Candidate | undefined)[] = run.map((line) => this.#candidate(file, line));
		const anchored: Record<Side, boolean> = { old: false, new: false };
		for (const [i, line] of run.entries()) {
			const candidate = candidates[i];
			if (candidate !== undefined && !candidate.weak) anchored[sideOf(line)] = true;
		}
		for (const [i, line] of run.entries()) {
			const side = sideOf(line);
			const number = lineNumberOf(line);
			const candidate = candidates[i];
			const result = sides[side];
			if (candidate !== undefined && (!candidate.weak || anchored[side])) {
				const before = fileAssignment(this.#input.previous.state, candidate.previous);
				const value = sideMap(before, side).get(candidate.line);
				if (value !== undefined) {
					this.#count(candidate.previous, 1);
					result.assignments.add(number, value);
					const marked = linesInSet(
						this.#input.previous.marks,
						candidate.previous.file.path,
						side
					).has(candidate.line);
					if (marked) result.reviewed.push(number);
					continue;
				}
			}
			const value = sideMap(initial, side).get(number);
			if (value === undefined) throw new Error(`Line ${String(number)} is not a change line.`);
			result.assignments.add(number, value);
			result.fresh.push(number);
		}
	}

	/** The units of `set`, a set of the previous version's units, that are the same units in the new one. */
	unitSet(set: UnitSet): UnitSet {
		const files = new Map<RepoPath, FileUnitSet>();
		for (const file of this.#input.diff.files) {
			const sides: Record<Side, number[]> = { old: [], new: [] };
			for (const hunk of file.hunks.values()) {
				for (const line of hunk.lines) {
					const found = this.#candidate(file, line);
					if (found === undefined || found.weak) continue;
					const before = set.files.get(found.previous.file.path);
					if (before === undefined) continue;
					switch (line.kind) {
						case 'added':
							if (before.new.has(found.line)) sides.new.push(line.new);
							break;
						case 'deleted':
							if (before.old.has(found.line)) sides.old.push(line.old);
							break;
						case 'context':
							break;
					}
				}
			}
			const previous = this.#input.previous.diff.byPath.get(file.file.path);
			const own =
				file.hasFileUnit &&
				previous !== undefined &&
				sameFileUnit(previous, file) &&
				fileUnitInSet(set, previous.file.path);
			const units = fileUnitsOf(
				RangeSet.fromNumbers(sides.old),
				RangeSet.fromNumbers(sides.new),
				own
			);
			if (units !== undefined) files.set(file.file.path, units);
		}
		return { files };
	}

	/** Where a change line of the new diff was a change line of the previous one, if anywhere. */
	#candidate(file: DiffFile, line: DiffLine): Candidate | undefined {
		switch (line.kind) {
			case 'context':
				return undefined;
			case 'added': {
				const now = file.file.new;
				if (now === undefined) return undefined;
				const origin = this.#heads.origin(now.path, line.new);
				if (origin === undefined) return undefined;
				const previous = this.#previous.byNewPath.get(origin.path);
				if (previous === undefined || !previous.changed.new.has(origin.line)) return undefined;
				return {
					previous,
					line: origin.line,
					weak: origin.weak
				};
			}
			case 'deleted': {
				const old = file.file.old;
				if (old === undefined) return undefined;
				const origin = this.#bases.origin(old.path, line.old);
				if (origin === undefined) return undefined;
				const headPath =
					file.file.new === undefined ? undefined : this.#heads.earlierPath(file.file.new.path);
				const previous = this.#previous.byOldPath
					.get(origin.path)
					?.find((f) =>
						file.file.new === undefined
							? f.file.new === undefined
							: f.file.new !== undefined && f.file.new.path === headPath
					);
				if (previous === undefined || !previous.changed.old.has(origin.line)) return undefined;
				return {
					previous,
					line: origin.line,
					weak: origin.weak
				};
			}
		}
	}

	#summary(
		state: AssignmentState,
		marks: ReviewedMarks,
		fresh: UnitSet,
		previousOf: ReadonlyMap<RepoPath, DiffFile | undefined>
	): UpdateSummary {
		const previous = this.#input.previous;
		let changed = 0;
		let newToReview = NO_UNITS;
		let newIgnored = NO_UNITS;
		let matched = 0;
		const seen = new Set<RepoPath>();
		for (const file of this.#input.diff.files) {
			const path = file.file.path;
			const counts = freshCounts(state, file, fresh.files.get(path));
			newToReview = addUnits(newToReview, counts.toReview);
			newIgnored = addUnits(newIgnored, counts.ignored);
			const before = previousOf.get(path);
			// The previous file at the same path is this file too, even when another one moved here.
			const samePath = previous.diff.byPath.get(path);
			let lost = 0;
			for (const earlier of new Set([before, samePath])) {
				if (earlier === undefined) continue;
				lost += earlier.unitCount - (this.#matched.get(earlier.file.path) ?? 0);
				seen.add(earlier.file.path);
			}
			if (before === undefined || counts.toReview + counts.ignored > 0 || lost > 0) changed += 1;
		}
		for (const count of this.#matched.values()) matched += count;
		// Every previous file at a path this version has a file at was seen above.
		const gone = previous.diff.files.filter((f) => !seen.has(f.file.path)).length;
		return {
			filesChanged: fileCountOf(changed + gone),
			filesGone: fileCountOf(gone),
			newToReview,
			newIgnored,
			gone: unitCountOf(previous.diff.unitCount - matched),
			reviewedBefore: unitSetSize(previous.marks),
			reviewedKept: unitSetSize(marks)
		};
	}
}

/** Carries the previous version's state and marks over to the new diff (see the top of this file). */
export function carryOver(input: CarryOverInput): CarriedOver {
	return new CarryOver(input).run();
}

/**
 * Sets of units of the previous version, such as each section's
 * cross-references, as the same units of the new one: a line goes with it when
 * it is the same line by the rule `carryOver` matches lines by, and was firmly
 * placed (a weak match is dropped, as when in doubt); a file-level unit when the
 * file's own change is the same. What has no match is left out.
 */
export function carryUnitSets<K>(
	input: CarryOverInput,
	sets: ReadonlyMap<K, UnitSet>
): ReadonlyMap<K, UnitSet> {
	const carried = new Map<K, UnitSet>();
	if (sets.size === 0) return carried;
	const carry = new CarryOver(input);
	for (const [key, set] of sets) {
		const out = carry.unitSet(set);
		if (out.files.size > 0) carried.set(key, out);
	}
	return carried;
}

/** How many of a file's new units are to review, and how many a rule or pattern ignored. */
function freshCounts(
	state: AssignmentState,
	file: DiffFile,
	fresh: FileUnitSet | undefined
): { readonly toReview: UnitCount; readonly ignored: UnitCount } {
	if (fresh === undefined) return { toReview: NO_UNITS, ignored: NO_UNITS };
	const assignment = fileAssignment(state, file);
	let toReview = 0;
	let ignored = 0;
	if (fresh.file && assignment.file !== undefined) {
		if (assignment.file.bucket.kind === 'ignored') ignored += 1;
		else toReview += 1;
	}
	for (const side of ['old', 'new'] as const) {
		const lines = side === 'old' ? fresh.old : fresh.new;
		for (const segment of sideMap(assignment, side).within(lines)) {
			const size = segment.last - segment.first + 1;
			if (segment.value.bucket.kind === 'ignored') ignored += size;
			else toReview += size;
		}
	}
	return { toReview: unitCountOf(toReview), ignored: unitCountOf(ignored) };
}

function sideOf(line: DiffLine): Side {
	return line.kind === 'deleted' ? 'old' : 'new';
}

function lineNumberOf(line: DiffLine): number {
	switch (line.kind) {
		case 'added':
		case 'context':
			return line.new;
		case 'deleted':
			return line.old;
	}
}

/**
 * Whether a file's file-level unit stands for the same change as the previous
 * version's file at its path (see the top of this file).
 */
function sameFileUnit(previous: DiffFile, now: DiffFile): boolean {
	if (!previous.hasFileUnit) return false;
	const a = previous.file;
	const b = now.file;
	if (a.status !== b.status || a.content.kind !== b.content.kind) return false;
	const sameSide = (x: FileVersion | undefined, y: FileVersion | undefined): boolean => {
		if (x === undefined || y === undefined) return x === y;
		return x.path === y.path && x.mode === y.mode && (now.hasLines || x.blob === y.blob);
	};
	return sameSide(a.old, b.old) && sameSide(a.new, b.new);
}
