/**
 * What the reviewer reads and ticks (DESIGN 4.3, 5, 8.2): each file's parts, one
 * for each group of the view it has changes in, with what the part says about
 * itself before its lines are drawn, and the page's frame: the groups in reading
 * order with their parts, and every file once, in path order, with the groups
 * its parts are in.
 *
 * A part is a slice (`slices.ts`); the screen never calls it one. Its tally
 * counts its own units: each added line, each removed line, and the change to
 * the file itself when it is in this part are one change each (DESIGN 8.5), so
 * the frame, the list of diffs, the command and the stored progress count the
 * same things.
 */
import type { AgentMarkdown } from '../agent-markdown.tiny.ts';
import type { Diff, DiffFile } from '../diff/diff.ts';
import {
	describeFileChange,
	describeFileLines,
	describeFileUnit,
	modeChangeOf,
	type ModeChange
} from '../diff/file-unit.ts';
import { ignoreRuleName } from '../diff/path-rules.ts';
import {
	fileSlices,
	groupKeyId,
	inReadingOrder,
	type GroupKey,
	type Slice
} from '../diff/slices.ts';
import type { Assignment, AssignmentState } from '../diff/state.ts';
import { fileUnitInSet, linesInSet, type UnitSet } from '../diff/unit-set.ts';
import type { ViewKind } from '../diff/slices.ts';
import type { GroupKeyId } from '../group-key-id.tiny.ts';
import { lineCountOf, type LineCount } from '../line-count.tiny.ts';
import { partPositionOf, type PartPosition } from '../part-position.tiny.ts';
import type { RepoPath } from '../repo-path.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import type { ReviewedMarks } from '../review/reviewed-marks.ts';
import type { SectionId } from '../section-id.tiny.ts';
import { sliceCountOf, type SliceCount } from '../slice-count.tiny.ts';
import { unitCountOf, type UnitCount } from '../unit-count.tiny.ts';

/** Why a part is ignored, as the page says it. The agent's reason is shown as the agent's. */
export type IgnoreReason =
	| { readonly kind: 'stated'; readonly text: ReviewerMessage }
	| { readonly kind: 'agent'; readonly reason: AgentMarkdown };

/** How far one part, file or group has got. */
export interface PartTally {
	/** Its changes. */
	readonly units: UnitCount;
	/** Of them, marked reviewed. */
	readonly reviewed: UnitCount;
	/** Of them, new since the previous version. */
	readonly fresh: UnitCount;
	/**
	 * Of them, unmarked by the update that made this version because something
	 * close to them changed, and not marked again since.
	 */
	readonly unmarked: UnitCount;
}

export const EMPTY_TALLY: PartTally = {
	units: unitCountOf(0),
	reviewed: unitCountOf(0),
	fresh: unitCountOf(0),
	unmarked: unitCountOf(0)
};

/** The sum of tallies. */
export function addTallies(...tallies: readonly PartTally[]): PartTally {
	let units = 0;
	let reviewed = 0;
	let fresh = 0;
	let unmarked = 0;
	for (const t of tallies) {
		units += t.units;
		reviewed += t.reviewed;
		fresh += t.fresh;
		unmarked += t.unmarked;
	}
	return {
		units: unitCountOf(units),
		reviewed: unitCountOf(reviewed),
		fresh: unitCountOf(fresh),
		unmarked: unitCountOf(unmarked)
	};
}

/** One file's part within one group, as the page lists it before drawing its lines. */
export interface PartSummary {
	readonly group: GroupKey;
	readonly file: DiffFile;
	/**
	 * How the file changed, in plain words, saying only what is in this part:
	 * "changed", "added", "renamed from src/old.ts", "changed, made executable".
	 */
	readonly change: ReviewerMessage;
	/** The lines this part adds and removes. */
	readonly added: LineCount;
	readonly removed: LineCount;
	/** What the change to the file itself stands for, when it is in this part: "made executable". */
	readonly fileUnit: ReviewerMessage | undefined;
	/**
	 * A change to the file's mode or kind, when it is in this part, such as being
	 * made executable: shown so it cannot be missed.
	 */
	readonly modeChange: ModeChange | undefined;
	/** In Ignored: why, each reason once. Empty elsewhere. */
	readonly ignored: readonly IgnoreReason[];
	readonly tally: PartTally;
	/** How many rows its lines take when drawn, hidden unchanged lines aside: a measure of its size. */
	readonly rows: LineCount;
	/** Its place among the file's parts, in reading order: part 2 of 3. */
	readonly position: PartPosition;
	readonly of: SliceCount;
	/** The groups the file's other parts are in, in reading order. */
	readonly others: readonly GroupKey[];
}

/** No changes marked, new or unmarked. */
export const NO_PART_MARKS: PartMarks = {
	reviewed: { files: new Map() },
	fresh: { files: new Map() },
	unmarked: { files: new Map() }
};

/** Whether a part still waits for the reviewer: it has changes not marked, outside Ignored. */
export function needsReview(part: {
	readonly group: GroupKey;
	readonly tally: PartTally;
}): boolean {
	return part.group.kind !== 'ignored' && part.tally.reviewed < part.tally.units;
}

/** Whether every change of a part is marked reviewed. */
export function isReviewed(tally: PartTally): boolean {
	return tally.units > 0 && tally.reviewed === tally.units;
}

function reasonOf(assignment: Assignment): IgnoreReason | undefined {
	const bucket = assignment.bucket;
	if (bucket.kind !== 'ignored') return undefined;
	switch (bucket.by.kind) {
		case 'rule':
			return { kind: 'stated', text: reviewerMessage(ignoreRuleName(bucket.by.rule)) };
		case 'pattern':
			return {
				kind: 'stated',
				text: reviewerMessage(`Matches the project’s pattern ${bucket.by.pattern}`)
			};
		case 'agent':
			return { kind: 'agent', reason: bucket.by.reason };
	}
}

function sameReason(a: IgnoreReason, b: IgnoreReason): boolean {
	switch (a.kind) {
		case 'stated':
			return b.kind === 'stated' && a.text === b.text;
		case 'agent':
			return b.kind === 'agent' && a.reason === b.reason;
	}
}

/** The sets a tally is counted against. */
export interface PartMarks {
	readonly reviewed: ReviewedMarks;
	readonly fresh: UnitSet;
	readonly unmarked: UnitSet;
}

interface Counted {
	readonly tally: PartTally;
	readonly added: number;
	readonly removed: number;
	readonly rows: number;
	readonly ignored: readonly IgnoreReason[];
}

function countSlice(slice: Slice, marks: PartMarks): Counted {
	const path = slice.file.path;
	const reviewedOld = linesInSet(marks.reviewed, path, 'old');
	const reviewedNew = linesInSet(marks.reviewed, path, 'new');
	const freshOld = linesInSet(marks.fresh, path, 'old');
	const freshNew = linesInSet(marks.fresh, path, 'new');
	const unmarkedOld = linesInSet(marks.unmarked, path, 'old');
	const unmarkedNew = linesInSet(marks.unmarked, path, 'new');
	let units = 0;
	let reviewed = 0;
	let fresh = 0;
	let unmarked = 0;
	let added = 0;
	let removed = 0;
	let rows = 0;
	const reasons: IgnoreReason[] = [];
	const note = (assignment: Assignment): void => {
		const reason = reasonOf(assignment);
		if (reason !== undefined && !reasons.some((r) => sameReason(r, reason))) reasons.push(reason);
	};
	if (slice.fileUnit !== undefined) {
		note(slice.fileUnit);
		units += 1;
		const marked = fileUnitInSet(marks.reviewed, path);
		if (marked) reviewed += 1;
		if (fileUnitInSet(marks.fresh, path)) fresh += 1;
		if (!marked && fileUnitInSet(marks.unmarked, path)) unmarked += 1;
	}
	for (const hunk of slice.hunks) {
		rows += hunk.lines.length;
		for (const line of hunk.lines) {
			if (line.kind !== 'own') continue;
			note(line.assignment);
			units += 1;
			const isAdded = line.line.kind === 'added';
			const number = line.line.kind === 'added' ? line.line.new : line.line.old;
			if (isAdded) added += 1;
			else removed += 1;
			const marked = (isAdded ? reviewedNew : reviewedOld).has(number);
			if (marked) reviewed += 1;
			if ((isAdded ? freshNew : freshOld).has(number)) fresh += 1;
			if (!marked && (isAdded ? unmarkedNew : unmarkedOld).has(number)) unmarked += 1;
		}
	}
	return {
		tally: {
			units: unitCountOf(units),
			reviewed: unitCountOf(reviewed),
			fresh: unitCountOf(fresh),
			unmarked: unitCountOf(unmarked)
		},
		added,
		removed,
		rows,
		ignored: reasons
	};
}

/** Whether a file's change has lines at all, in this part or another. */
function hasLinesAnywhere(file: DiffFile): boolean {
	return file.hasLines;
}

function changeOf(slice: Slice, file: DiffFile, hasLines: boolean): ReviewerMessage {
	// Only what waits in this part: a file's lines and the change to the file itself may be apart.
	if (slice.fileUnit === undefined) return describeFileLines(file.file);
	// A change of mode or kind is shown on its own, beside these words (`modeChange`).
	return hasLines || !hasLinesAnywhere(file)
		? describeFileChange(file.file, { withMode: false })
		: describeFileUnit(file.file, { withMode: false });
}

/**
 * One file's parts in `view`, in reading order: the sections in the order
 * given, then the others as the views order them.
 */
export function fileParts(
	file: DiffFile,
	state: AssignmentState,
	marks: PartMarks,
	view: ViewKind,
	sections: readonly SectionId[]
): readonly PartSummary[] {
	const slices = inReadingOrder(fileSlices(file, state, view), (s) => s.group, sections);
	const of = sliceCountOf(slices.length);
	return slices.map(({ group, slice }, index): PartSummary => {
		const counted = countSlice(slice, marks);
		const hasLines = counted.added + counted.removed > 0;
		const id = groupKeyId(group);
		return {
			group,
			file,
			change: changeOf(slice, file, hasLines),
			added: lineCountOf(counted.added),
			removed: lineCountOf(counted.removed),
			fileUnit: slice.fileUnit === undefined ? undefined : describeFileUnit(file.file),
			modeChange: slice.fileUnit === undefined ? undefined : modeChangeOf(file.file),
			ignored: counted.ignored,
			tally: counted.tally,
			rows: lineCountOf(counted.rows),
			position: partPositionOf(index + 1),
			of,
			others: slices.map((s) => s.group).filter((g) => groupKeyId(g) !== id)
		};
	});
}

/** A group of the frame: its parts, in the diff's file order, and its tally. */
export interface FrameGroup {
	readonly key: GroupKey;
	readonly parts: readonly PartSummary[];
	readonly tally: PartTally;
}

/** A file of the frame's by-file view. */
export interface FrameFile {
	readonly file: DiffFile;
	/** How the whole file changed: "changed, renamed from src/old.ts". */
	readonly change: ReviewerMessage;
	readonly added: LineCount;
	readonly removed: LineCount;
	/** Its parts outside Ignored. */
	readonly tally: PartTally;
	/** Its changes in Ignored, which need no review. */
	readonly ignored: UnitCount;
	/** Its parts, in reading order. */
	readonly parts: readonly PartSummary[];
}

/**
 * The page's frame: the groups of `view` in reading order, each with its parts,
 * and every file once in the diff's order (by path), with its parts. Empty
 * groups are left out, except a section, which the reviewer may still look for.
 */
export interface Frame {
	readonly groups: readonly FrameGroup[];
	readonly files: readonly FrameFile[];
	/** Every part outside Ignored. */
	readonly overall: PartTally;
	/** Every part in Ignored. */
	readonly ignored: PartTally;
}

/** The tally of a file's parts outside Ignored, and its changes in Ignored. */
export function fileTally(parts: readonly PartSummary[]): {
	readonly tally: PartTally;
	readonly ignored: UnitCount;
} {
	const counted = parts.filter((p) => p.group.kind !== 'ignored').map((p) => p.tally);
	const ignored = parts.filter((p) => p.group.kind === 'ignored').map((p) => p.tally);
	return { tally: addTallies(...counted), ignored: addTallies(...ignored).units };
}

/** The frame of a diff in `view`. `sections` is the sections' reading order. */
export function frameOf(
	diff: Diff,
	state: AssignmentState,
	marks: PartMarks,
	view: ViewKind,
	sections: readonly SectionId[]
): Frame {
	const groups = new Map<GroupKeyId, { key: GroupKey; parts: PartSummary[] }>();
	const ensure = (key: GroupKey): { key: GroupKey; parts: PartSummary[] } => {
		const id = groupKeyId(key);
		let group = groups.get(id);
		if (group === undefined) {
			group = { key, parts: [] };
			groups.set(id, group);
		}
		return group;
	};
	for (const section of sections) ensure({ kind: 'section', section });
	const files: FrameFile[] = [];
	for (const file of diff.files) {
		const parts = fileParts(file, state, marks, view, sections);
		for (const part of parts) ensure(part.group).parts.push(part);
		const { tally, ignored } = fileTally(parts);
		files.push({
			file,
			change: describeFileChange(file.file),
			added: lineCountOf(file.changed.new.size),
			removed: lineCountOf(file.changed.old.size),
			tally,
			ignored,
			parts
		});
	}
	const ordered = inReadingOrder([...groups.values()], (g) => g.key, sections)
		.filter((g) => g.parts.length > 0 || g.key.kind === 'section')
		.map((g): FrameGroup => ({
			key: g.key,
			parts: g.parts,
			tally: addTallies(...g.parts.map((p) => p.tally))
		}));
	const counted = ordered.filter((g) => g.key.kind !== 'ignored').map((g) => g.tally);
	const ignored = ordered.filter((g) => g.key.kind === 'ignored').map((g) => g.tally);
	return {
		groups: ordered,
		files,
		overall: addTallies(...counted),
		ignored: addTallies(...ignored)
	};
}

/** The parts of the files at `paths`, for the page to update after a mark. */
export function partsOfFiles(
	diff: Diff,
	state: AssignmentState,
	marks: PartMarks,
	view: ViewKind,
	sections: readonly SectionId[],
	paths: Iterable<RepoPath>
): readonly PartSummary[] {
	const parts: PartSummary[] = [];
	for (const path of paths) {
		const file = diff.byPath.get(path);
		if (file !== undefined) parts.push(...fileParts(file, state, marks, view, sections));
	}
	return parts;
}
