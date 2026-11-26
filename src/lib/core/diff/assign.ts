/**
 * `assign` (DESIGN 7.1): puts change units in a section or in `Ignored`, and
 * optionally sets their role.
 *
 * Each item names a target and what to do with it:
 *
 * - A whole file or a glob of files takes only what is still uncategorised in
 *   those files, so it never undoes earlier, finer work.
 * - A whole file or a glob takes the file's file-level unit with its lines, when
 *   it has one (`file-unit.ts`).
 * - Hunk ids or line ranges within a file move exactly those units, wherever they
 *   were: the last write wins. Hunks hold lines only; the label `file` among the
 *   line ranges (`"lines": "file"`, or `"file,+40..+62"`) names the file-level
 *   unit, as the agent text labels it. A line range takes the changed lines inside it and
 *   may span unchanged lines (DESIGN 7.1). An item is rejected only when all its
 *   ranges together hold no changed line, naming the nearest changed lines; a
 *   range that holds none inside an item that takes something is reported in
 *   the accepted item, so copying both sides of a hunk heading for a hunk that
 *   only adds lines still works.
 * - An item with a role and no section sets the role of every unit it targets,
 *   and leaves their buckets alone. With a section, the role is set on the units
 *   the item takes.
 *
 * Items apply in order, each all or nothing: a valid item applies even when
 * another in the same call is rejected, and a rejected item changes nothing.
 * The input state is never changed.
 */
import {
	MAX_AGENT_MARKDOWN_LENGTH,
	parseAgentMarkdown,
	type AgentMarkdown
} from '../agent-markdown.tiny.ts';
import { jsonQuoted } from '../json-quoted.ts';
import { compileGlob, parseGlobPattern, type GlobPattern } from '../glob-pattern.tiny.ts';
import { describeGlobProblem, type GlobProblem } from '../glob.ts';
import { parseHunkId, type HunkId } from '../hunk-id.tiny.ts';
import { formatLineRange, formatLineRanges, lineRangesOf, type LineRange } from '../line-range.ts';
import { RangeSet } from '../range-set.ts';
import { itemIndexAt, type ItemIndex } from '../item-index.tiny.ts';
import { resolveEscapedPath } from '../path-bytes.ts';
import { textForAgent, type TextForAgent } from '../text-for-agent.tiny.ts';
import { addUnits, NO_UNITS, ONE_UNIT, unitCountOf, type UnitCount } from '../unit-count.tiny.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import { err, ok, type Result } from '../result.ts';
import { parseRole, type Role } from '../role.tiny.ts';
import { parseSectionId, type InvalidSectionIdReason, type SectionId } from '../section-id.tiny.ts';
import type { Side } from '../side.tiny.ts';
import { agentPath } from './agent-text.ts';
import { ignoredBucket, sameBucket, sectionBucket, type Bucket } from './bucket.ts';
import { changedLines, type Diff, type DiffFile, type SideLines } from './diff.ts';
import { describeBucket } from './coverage.ts';
import { parseUnitSpec, type MalformedLinesProblem } from './line-spec.ts';
import { countUncategorised } from './totals.ts';
import type { FileUnitSet } from './unit-set.ts';
import {
	assignedUnits,
	fileAssignment,
	type Assignment,
	type AssignmentState,
	type FileAssignment
} from './state.ts';

// --- Requests, as the agent sends them -----------------------------------------

/**
 * One `assign` item exactly as the agent wrote it, after the MCP schema has
 * checked its shape. `parseAssignRequest` checks its meaning.
 *
 * Name the target with `file` alone, `glob` alone, `file` with `hunks`, or `file`
 * with `lines`. Name the destination with `section` (a section id, or `ignored`
 * with a `reason`), and optionally a `role`.
 */
export interface AssignRequest {
	readonly file?: string;
	readonly glob?: string;
	readonly hunks?: readonly string[];
	/** Line ranges such as `+40..+62,-38..-45`, and `file` for the file-level unit. */
	readonly lines?: string;
	/** A section id, or `ignored`. */
	readonly section?: string;
	/** Why the lines are ignored; required with `section: "ignored"`. */
	readonly reason?: string;
	readonly role?: string;
}

/** The section id that means the `Ignored` bucket in a request. */
export const IGNORED_SECTION = 'ignored';

// --- Items, once understood ----------------------------------------------------

export type AssignTarget =
	| { readonly kind: 'file'; readonly path: RepoPath }
	| { readonly kind: 'glob'; readonly glob: GlobPattern }
	| { readonly kind: 'hunks'; readonly path: RepoPath; readonly hunks: readonly HunkId[] }
	| {
			readonly kind: 'lines';
			readonly path: RepoPath;
			readonly ranges: readonly LineRange[];
			/** Whether the file-level unit is named too (`file`). */
			readonly file: boolean;
	  };

export type Destination =
	| { readonly kind: 'section'; readonly section: SectionId }
	| { readonly kind: 'ignored'; readonly reason: AgentMarkdown };

export interface AssignItem {
	readonly target: AssignTarget;
	/** Absent when the item only sets a role. */
	readonly destination: Destination | undefined;
	readonly role: Role | undefined;
}

// --- Rejections ----------------------------------------------------------------

export type InvalidItemProblem =
	| 'no-target'
	| 'glob-with-file'
	| 'hunks-and-lines'
	| 'no-file'
	| 'empty-hunks'
	| 'nothing-to-do'
	| 'reason-without-ignored';

/** Why an item was not applied. Each one says enough for the agent to fix the item. */
export type AssignRejection =
	| { readonly kind: 'InvalidItem'; readonly problem: InvalidItemProblem }
	| {
			readonly kind: 'UnknownFile';
			readonly file: string;
			/** Paths in the diff the agent may have meant. */
			readonly similar: readonly RepoPath[];
	  }
	| {
			/** Strings in `hunks` that are not hunk ids at all, such as `1` or `H2`. */
			readonly kind: 'MalformedHunkId';
			readonly file: RepoPath;
			readonly hunks: readonly string[];
			/** The file's hunk ids, filled in from the diff. */
			readonly known: readonly HunkId[];
	  }
	| {
			readonly kind: 'UnknownHunk';
			readonly file: RepoPath;
			readonly hunks: readonly string[];
			readonly known: readonly HunkId[];
	  }
	| {
			/**
			 * A requested range holds no changed line on its side. A range may span
			 * unchanged lines and takes the changed ones inside it; only one that
			 * holds none at all is a slip worth refusing.
			 */
			readonly kind: 'NoChangedLines';
			readonly file: RepoPath;
			/** The requested ranges that hold no changed line. */
			readonly ranges: readonly LineRange[];
			/**
			 * A few changed lines nearest those ranges: on the same side, or on the
			 * other side when that side has none.
			 */
			readonly nearest: readonly LineRange[];
	  }
	| {
			/** Line ranges were given for a file whose change has no lines (binary, rename, ...). */
			readonly kind: 'NoLinesInFile';
			readonly file: RepoPath;
	  }
	| {
			/** `file` was given for a file whose name, mode and kind did not change. */
			readonly kind: 'NoFileUnit';
			readonly file: RepoPath;
	  }
	| {
			readonly kind: 'MalformedLines';
			readonly text: string;
			readonly part: string;
			readonly problem: MalformedLinesProblem;
	  }
	| { readonly kind: 'MalformedGlob'; readonly glob: string; readonly problem: GlobProblem }
	| { readonly kind: 'GlobMatchesNothing'; readonly glob: GlobPattern }
	| {
			readonly kind: 'InvalidSectionId';
			readonly section: string;
			readonly reason: InvalidSectionIdReason;
	  }
	| {
			readonly kind: 'UnknownSection';
			readonly section: SectionId;
			readonly known: readonly SectionId[];
	  }
	| { readonly kind: 'MissingReason' }
	/** The reason is there but cannot be kept: too long, or not well-formed text. */
	| { readonly kind: 'InvalidReason'; readonly problem: 'too-long' | 'malformed' }
	| { readonly kind: 'InvalidRole'; readonly role: string };

// --- Outcome -------------------------------------------------------------------

export interface AssignOptions {
	/** When given, a section must be one of these. */
	readonly knownSections?: ReadonlySet<SectionId>;
}

/**
 * Why a whole-file or glob item took nothing although it was valid: every unit
 * it covers was already in a bucket, and such an item takes only what is still
 * uncategorised.
 */
export interface NothingTaken {
	readonly target: AssignTarget;
	/** The buckets the units are in, at most a few. */
	readonly sortedInto: readonly Bucket[];
	/** Some of the units were still uncategorised when the call began: an earlier item of it took them. */
	readonly takenEarlierInCall: boolean;
}

/**
 * Ranges of an accepted `lines` item that held no changed line on their side,
 * while its other ranges took something. Reported, not refused (DESIGN 7.1).
 */
export interface RangesTakingNothing {
	readonly file: RepoPath;
	readonly ranges: readonly LineRange[];
}

export interface AcceptedItem {
	/** The item's position in the request. */
	readonly index: ItemIndex;
	/** How many units it took. */
	readonly units: UnitCount;
	/** When it took none, why. */
	readonly nothingTaken: NothingTaken | undefined;
	/** The item's line ranges that took nothing, when some of them did. */
	readonly rangesTakingNothing: RangesTakingNothing | undefined;
	/**
	 * Of the units it took, those that were in another section, or ignored when
	 * it sends them to a section, or in a section when it ignores them: where
	 * from and how many. Empty when it took only what was not sorted, or what
	 * was already where it sends it: then undefined, as the fields above are when they say nothing.
	 */
	readonly movedFrom: readonly MovedFrom[] | undefined;
}

/** Units an item moved out of a bucket. */
export interface MovedFrom {
	readonly bucket: Bucket;
	readonly units: UnitCount;
}

export interface AssignOutcome {
	readonly state: AssignmentState;
	/** Each applied item, by its position in the request. */
	readonly accepted: readonly AcceptedItem[];
	readonly rejected: readonly { readonly index: ItemIndex; readonly rejection: AssignRejection }[];
	/** How many units of the whole diff are still uncategorised afterwards. */
	readonly uncategorised: UnitCount;
}

/** Applies the agent's items to a state and says what each one did. */
export function assign(
	diff: Diff,
	state: AssignmentState,
	requests: readonly AssignRequest[],
	options: AssignOptions = {}
): AssignOutcome {
	const parsed = requests.map((request) => {
		const item = parseAssignRequest(request);
		return item.ok ? item : err(withDiffContext(diff, item.error));
	});
	return applyItems(diff, state, parsed, options);
}

/** Like `assign`, for items that are already typed. */
export function assignItems(
	diff: Diff,
	state: AssignmentState,
	items: readonly AssignItem[],
	options: AssignOptions = {}
): AssignOutcome {
	return applyItems(diff, state, items.map(ok), options);
}

function applyItems(
	diff: Diff,
	state: AssignmentState,
	items: readonly Result<AssignItem, AssignRejection>[],
	options: AssignOptions
): AssignOutcome {
	let current = state;
	const accepted: AcceptedItem[] = [];
	const rejected: { index: ItemIndex; rejection: AssignRejection }[] = [];
	items.forEach((item, position) => {
		const index = itemIndexAt(position);
		const applied = item.ok ? applyItem(diff, current, item.value, options) : item;
		if (applied.ok) {
			const nothingTaken =
				applied.value.units === 0 && item.ok
					? whyNothingTaken(state, current, item.value, applied.value.files)
					: undefined;
			current = applied.value.state;
			accepted.push({
				index,
				units: applied.value.units,
				nothingTaken,
				rangesTakingNothing: applied.value.rangesTakingNothing,
				movedFrom: applied.value.movedFrom.length === 0 ? undefined : applied.value.movedFrom
			});
		} else {
			rejected.push({ index, rejection: applied.error });
		}
	});
	return { state: current, accepted, rejected, uncategorised: countUncategorised(diff, current) };
}

// --- Parsing a request ---------------------------------------------------------

/** Checks what a request means, without looking at the diff. */
export function parseAssignRequest(request: AssignRequest): Result<AssignItem, AssignRejection> {
	const target = parseTarget(request);
	if (!target.ok) return target;

	let destination: Destination | undefined;
	if (request.section === IGNORED_SECTION) {
		const reason = parseAgentMarkdown(request.reason ?? '');
		if (!reason.ok) {
			return reason.error.reason === 'blank'
				? err({ kind: 'MissingReason' })
				: err({ kind: 'InvalidReason', problem: reason.error.reason });
		}
		destination = { kind: 'ignored', reason: reason.value };
	} else if (request.section !== undefined) {
		if (request.reason !== undefined) {
			return err({ kind: 'InvalidItem', problem: 'reason-without-ignored' });
		}
		const section = parseSectionId(request.section);
		if (!section.ok) {
			return err({
				kind: 'InvalidSectionId',
				section: request.section,
				reason: section.error.reason
			});
		}
		destination = { kind: 'section', section: section.value };
	} else if (request.reason !== undefined) {
		return err({ kind: 'InvalidItem', problem: 'reason-without-ignored' });
	}

	let role: Role | undefined;
	if (request.role !== undefined) {
		const parsedRole = parseRole(request.role);
		if (!parsedRole.ok) return err({ kind: 'InvalidRole', role: request.role });
		role = parsedRole.value;
	}
	if (destination === undefined && role === undefined) {
		return err({ kind: 'InvalidItem', problem: 'nothing-to-do' });
	}
	return ok({ target: target.value, destination, role });
}

function parseTarget(request: AssignRequest): Result<AssignTarget, AssignRejection> {
	const invalid = (problem: InvalidItemProblem): Result<never, AssignRejection> =>
		err({ kind: 'InvalidItem', problem });
	const { file, glob, hunks, lines } = request;

	if (glob !== undefined) {
		if (file !== undefined || hunks !== undefined || lines !== undefined) {
			return invalid('glob-with-file');
		}
		const pattern = parseGlobPattern(glob);
		if (!pattern.ok) return err({ kind: 'MalformedGlob', glob, problem: pattern.error.problem });
		return ok({ kind: 'glob', glob: pattern.value });
	}
	if (hunks !== undefined && lines !== undefined) return invalid('hunks-and-lines');
	if (file === undefined)
		return invalid(hunks !== undefined || lines !== undefined ? 'no-file' : 'no-target');

	const path = parseRepoPath(file);
	if (!path.ok) return err({ kind: 'UnknownFile', file, similar: [] });

	if (hunks !== undefined) {
		if (hunks.length === 0) return invalid('empty-hunks');
		const ids: HunkId[] = [];
		const bad: string[] = [];
		for (const hunk of hunks) {
			const id = parseHunkId(hunk);
			if (id.ok) ids.push(id.value);
			else bad.push(hunk);
		}
		if (bad.length > 0)
			return err({ kind: 'MalformedHunkId', file: path.value, hunks: bad, known: [] });
		return ok({ kind: 'hunks', path: path.value, hunks: ids });
	}
	if (lines !== undefined) {
		const spec = parseUnitSpec(lines);
		if (!spec.ok) return err(spec.error);
		return ok({
			kind: 'lines',
			path: path.value,
			ranges: spec.value.ranges,
			file: spec.value.file
		});
	}
	return ok({ kind: 'file', path: path.value });
}

/**
 * Completes a rejection found without the diff with what the diff knows: a file
 * that is not in it is reported as unknown first, and a malformed hunk id gets
 * the file's real hunk ids.
 */
function withDiffContext(diff: Diff, rejection: AssignRejection): AssignRejection {
	switch (rejection.kind) {
		case 'MalformedHunkId': {
			const file = findFile(diff, rejection.file);
			if (!file.ok) return file.error;
			return { ...rejection, known: [...file.value.hunks.keys()] };
		}
		case 'UnknownFile':
			return rejection.similar.length > 0
				? rejection
				: { ...rejection, similar: similarPaths(diff, rejection.file) };
		case 'InvalidItem':
		case 'UnknownHunk':
		case 'NoChangedLines':
		case 'NoLinesInFile':
		case 'NoFileUnit':
		case 'MalformedLines':
		case 'MalformedGlob':
		case 'GlobMatchesNothing':
		case 'InvalidSectionId':
		case 'UnknownSection':
		case 'MissingReason':
		case 'InvalidReason':
		case 'InvalidRole':
			return rejection;
	}
}

/**
 * The changed file a `file` value names, read as `assign` reads it: its path,
 * its escaped form, or that quoted as a JSON string; refused as `UnknownFile`
 * with the paths the agent may have meant.
 */
export function findDiffFile(diff: Diff, text: string): Result<DiffFile, AssignRejection> {
	const target = parseTarget({ file: text });
	if (!target.ok) return err(withDiffContext(diff, target.error));
	if (target.value.kind !== 'file') return err({ kind: 'UnknownFile', file: text, similar: [] });
	return findFile(diff, target.value.path);
}

/** The paths of a tree a `file` value may name, as `assign` reads it, most likely first. */
export function pathsNamedBy(text: string): readonly RepoPath[] {
	return pathsMeant(text);
}

/**
 * The changed units a file and a `lines` value name, as `assign` reads them,
 * for what else an agent points at with them, such as a section's
 * cross-references (DESIGN 4.3): only changed lines and the file-level unit,
 * never the unchanged lines a range spans. Refused as an `assign` item with
 * the same target would be, with the same rejections. Without `lines`, every
 * changed unit of the file.
 */
export function resolveUnits(
	diff: Diff,
	file: string,
	lines: string | undefined
): Result<{ readonly path: RepoPath; readonly units: FileUnitSet }, AssignRejection> {
	const target = parseTarget(lines === undefined ? { file } : { file, lines });
	if (!target.ok) return err(withDiffContext(diff, target.error));
	const resolved = resolveTarget(diff, target.value);
	if (!resolved.ok) return resolved;
	for (const [found, wanted] of resolved.value.files) {
		const changed = found.changed;
		const units =
			wanted.kind === 'whole'
				? { old: changed.old, new: changed.new, file: found.hasFileUnit }
				: {
						old: wanted.lines.old.intersect(changed.old),
						new: wanted.lines.new.intersect(changed.new),
						file: wanted.file && found.hasFileUnit
					};
		return ok({ path: found.file.path, units });
	}
	return err({ kind: 'InvalidItem', problem: 'no-target' });
}

// --- Applying an item ----------------------------------------------------------

/** The units of one file that an item targets: all of them, or some lines and perhaps the file-level unit. */
type FileTarget =
	| { readonly kind: 'whole' }
	| { readonly kind: 'lines'; readonly lines: SideLines; readonly file: boolean };

interface Resolved {
	readonly files: ReadonlyMap<DiffFile, FileTarget>;
	readonly rangesTakingNothing: RangesTakingNothing | undefined;
}

interface Applied {
	readonly state: AssignmentState;
	readonly units: UnitCount;
	readonly movedFrom: readonly MovedFrom[];
	/** The files the item covered. */
	readonly files: readonly DiffFile[];
	readonly rangesTakingNothing: RangesTakingNothing | undefined;
}

function applyItem(
	diff: Diff,
	state: AssignmentState,
	item: AssignItem,
	options: AssignOptions
): Result<Applied, AssignRejection> {
	const { destination } = item;
	if (destination?.kind === 'section' && options.knownSections !== undefined) {
		if (!options.knownSections.has(destination.section)) {
			return err({
				kind: 'UnknownSection',
				section: destination.section,
				known: [...options.knownSections].sort()
			});
		}
	}

	const targets = resolveTarget(diff, item.target);
	if (!targets.ok) return targets;

	const bucket = destination === undefined ? undefined : destinationBucket(destination);
	const wholeFiles = item.target.kind === 'file' || item.target.kind === 'glob';
	const onlyUncategorised = wholeFiles && bucket !== undefined;
	const change = (a: Assignment): Assignment => ({
		bucket: bucket ?? a.bucket,
		role: item.role ?? a.role
	});

	const files = new Map(state.files);
	let units = NO_UNITS;
	const movedFrom: MovedFrom[] = [];
	const moved = (from: Assignment, count: number): void => {
		if (bucket === undefined || !isMove(from.bucket, bucket) || count === 0) return;
		const at = movedFrom.findIndex((m) => sameBucket(m.bucket, from.bucket));
		const before = movedFrom[at];
		if (before === undefined) movedFrom.push({ bucket: from.bucket, units: unitCountOf(count) });
		else
			movedFrom[at] = { bucket: before.bucket, units: addUnits(before.units, unitCountOf(count)) };
	};
	for (const [file, target] of targets.value.files) {
		const updated = applyToFile(
			fileAssignment(state, file),
			target,
			onlyUncategorised,
			change,
			moved
		);
		files.set(file.file.path, updated.assignment);
		units = addUnits(units, updated.units);
	}
	return ok({
		state: { files },
		units,
		movedFrom,
		files: [...targets.value.files.keys()],
		rangesTakingNothing: targets.value.rangesTakingNothing
	});
}

const MAX_BUCKETS_NAMED = 3;

/** Why a valid item took no units, or undefined when the rules do not explain it. */
function whyNothingTaken(
	callStart: AssignmentState,
	before: AssignmentState,
	item: AssignItem,
	files: readonly DiffFile[]
): NothingTaken | undefined {
	const wholeFiles = item.target.kind === 'file' || item.target.kind === 'glob';
	if (!wholeFiles || item.destination === undefined) return undefined;
	const sortedInto: Bucket[] = [];
	let takenEarlierInCall = false;
	for (const file of files) {
		for (const run of assignedUnits(before, file)) {
			const bucket = run.assignment.bucket;
			if (!sortedInto.some((b) => sameBucket(b, bucket)) && sortedInto.length < MAX_BUCKETS_NAMED) {
				sortedInto.push(bucket);
			}
		}
		if (assignedUnits(callStart, file).some((u) => u.assignment.bucket.kind === 'uncategorised')) {
			takenEarlierInCall = true;
		}
	}
	return { target: item.target, sortedInto, takenEarlierInCall };
}

function destinationBucket(destination: Destination): Bucket {
	switch (destination.kind) {
		case 'section':
			return sectionBucket(destination.section);
		case 'ignored':
			return ignoredBucket({ kind: 'agent', reason: destination.reason });
	}
}

/** Whether taking units out of `from` into `to` moves them: out of a section, or between a section and Ignored. */
function isMove(from: Bucket, to: Bucket): boolean {
	if (from.kind === 'uncategorised') return false;
	if (from.kind === 'ignored' && to.kind === 'ignored') return false;
	return !sameBucket(from, to);
}

function applyToFile(
	assignment: FileAssignment,
	target: FileTarget,
	onlyUncategorised: boolean,
	change: (a: Assignment) => Assignment,
	moved: (from: Assignment, units: number) => void
): { readonly assignment: FileAssignment; readonly units: UnitCount } {
	const takes = (a: Assignment): boolean => !onlyUncategorised || a.bucket.kind === 'uncategorised';
	let units = NO_UNITS;
	const sides = { old: assignment.old, new: assignment.new };
	for (const side of ['old', 'new'] as const) {
		const map = sides[side];
		const wanted = target.kind === 'whole' ? map.domain : target.lines[side];
		const segments = map.within(wanted).filter((s) => takes(s.value));
		for (const segment of segments) moved(segment.value, segment.last - segment.first + 1);
		const taken = RangeSet.fromIntervals(segments);
		units = addUnits(units, unitCountOf(taken.size));
		sides[side] = map.update(taken, change);
	}
	let file = assignment.file;
	const wantsFile = target.kind === 'whole' || target.file;
	if (file !== undefined && wantsFile && takes(file)) {
		moved(file, 1);
		file = change(file);
		units = addUnits(units, ONE_UNIT);
	}
	return { assignment: { ...sides, file }, units };
}

function resolveTarget(diff: Diff, target: AssignTarget): Result<Resolved, AssignRejection> {
	const only = (files: ReadonlyMap<DiffFile, FileTarget>): Resolved => ({
		files,
		rangesTakingNothing: undefined
	});
	switch (target.kind) {
		case 'file': {
			const file = findFile(diff, target.path);
			return file.ok ? ok(only(new Map([[file.value, { kind: 'whole' } as const]]))) : file;
		}
		case 'glob': {
			const matches = compileGlob(target.glob);
			const files = diff.files.filter((f) => matches(f.file.path));
			if (files.length === 0) return err({ kind: 'GlobMatchesNothing', glob: target.glob });
			return ok(only(new Map(files.map((f) => [f, { kind: 'whole' } as const]))));
		}
		case 'hunks': {
			const file = findFile(diff, target.path);
			if (!file.ok) return file;
			const unknown = target.hunks.filter((id) => !file.value.hunks.has(id));
			if (unknown.length > 0) {
				return err({
					kind: 'UnknownHunk',
					file: target.path,
					hunks: unknown,
					known: [...file.value.hunks.keys()]
				});
			}
			let old = RangeSet.empty;
			let now = RangeSet.empty;
			for (const id of target.hunks) {
				const lines = file.value.hunkLines.get(id);
				if (lines === undefined) continue;
				old = old.union(lines.old);
				now = now.union(lines.new);
			}
			return ok(
				only(
					new Map([[file.value, { kind: 'lines', lines: { old, new: now }, file: false } as const]])
				)
			);
		}
		case 'lines': {
			const file = findFile(diff, target.path);
			if (!file.ok) return file;
			if (target.file && !file.value.hasFileUnit) {
				return err({ kind: 'NoFileUnit', file: target.path });
			}
			if (!target.file && !file.value.hasLines) {
				return err({ kind: 'NoLinesInFile', file: target.path });
			}
			const changed = file.value.changed;
			const empty = target.ranges.filter(
				(range) => !changedLines(file.value, range.side).overlaps(range.first, range.last)
			);
			// With `file`, the item takes the file-level unit, so ranges that hold nothing are only reported.
			if (!target.file && empty.length === target.ranges.length) {
				return err({
					kind: 'NoChangedLines',
					file: target.path,
					ranges: empty,
					nearest: nearestChanged(changed, empty)
				});
			}
			// Unchanged lines in the ranges belong to no unit, so applying them takes nothing.
			return ok({
				files: new Map([
					[file.value, { kind: 'lines', lines: linesOf(target.ranges), file: target.file } as const]
				]),
				rangesTakingNothing:
					empty.length === 0 ? undefined : { file: file.value.file.path, ranges: empty }
			});
		}
	}
}

/** How many changed lines on each side of a range a rejection names. */
const NEAREST_EACH_WAY = 2;

/** The most changed lines a rejection names in all. */
const MAX_NEAREST = 10;

/**
 * A few changed lines around the ranges that hold none: the nearest intervals
 * before and after each, found by binary search, on its side, or, when that
 * side has no changed lines at all, the first ones on the other side. At most
 * `MAX_NEAREST` in all, for the first ranges, so a large file or a long list of
 * ranges does not flood the agent or take long to build.
 */
function nearestChanged(changed: SideLines, ranges: readonly LineRange[]): readonly LineRange[] {
	const found: LineRange[] = [];
	const seen = new Set<string>();
	const add = (range: LineRange): void => {
		const key = `${range.side}:${range.first}`;
		if (seen.has(key)) return;
		seen.add(key);
		found.push(range);
	};
	const sideLines = (side: Side): RangeSet => (side === 'old' ? changed.old : changed.new);
	const intervals = (side: Side, from: number, to: number): readonly LineRange[] =>
		lineRangesOf(side, RangeSet.fromIntervals(sideLines(side).intervals.slice(from, to)));
	for (const range of ranges) {
		if (found.length >= MAX_NEAREST) break;
		const own = sideLines(range.side);
		if (own.isEmpty) {
			const other: Side = range.side === 'old' ? 'new' : 'old';
			for (const r of intervals(other, 0, 2 * NEAREST_EACH_WAY)) add(r);
			continue;
		}
		// The range holds no changed line, so the interval found starts after it.
		const after = own.firstEndingAtOrAfter(range.first);
		for (const r of intervals(
			range.side,
			Math.max(0, after - NEAREST_EACH_WAY),
			after + NEAREST_EACH_WAY
		)) {
			add(r);
		}
	}
	const order = (r: LineRange): number => (r.side === 'old' ? 0 : 1);
	return found.sort((a, b) => order(a) - order(b) || a.first - b.first).slice(0, MAX_NEAREST);
}

function linesOf(ranges: readonly LineRange[]): SideLines {
	const side = (s: Side): RangeSet => RangeSet.fromIntervals(ranges.filter((r) => r.side === s));
	return { old: side('old'), new: side('new') };
}

const MAX_SIMILAR = 5;

function findFile(diff: Diff, path: RepoPath): Result<DiffFile, AssignRejection> {
	for (const candidate of pathsMeant(path)) {
		const file = diff.byPath.get(candidate);
		if (file !== undefined) return ok(file);
	}
	return err({ kind: 'UnknownFile', file: path, similar: similarPaths(diff, path) });
}

/**
 * The paths a `file` value can stand for, in order: the path whose escaped form
 * it is (`resolveEscapedPath`), and the same for what a JSON string holds, when
 * the agent sent the quoted form from the agent text, quotes and all. The value
 * is never also taken literally when it is an escaped form, so `a\\xFF` names
 * the file whose name ends in the byte FF, never a file literally named so.
 */
function pathsMeant(text: string): readonly RepoPath[] {
	const meant: RepoPath[] = [];
	const resolved = resolveEscapedPath(text);
	if (resolved !== undefined) meant.push(resolved);
	if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
		const inner = jsonStringValue(text);
		if (inner !== undefined) meant.push(...pathsMeant(inner));
	}
	return meant;
}

function jsonStringValue(text: string): string | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === 'string' ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Paths the agent may have meant: a renamed file's new path, or the same file name elsewhere. */
function similarPaths(diff: Diff, path: string): readonly RepoPath[] {
	const stripped = withoutPrefix(path);
	const exact = diff.files.filter((f) => f.file.path === stripped).map((f) => f.file.path);
	const name = stripped.split('/').at(-1) ?? stripped;
	const renamedFrom = diff.files
		.filter((f) => f.file.old?.path === path || f.file.old?.path === stripped)
		.map((f) => f.file.path);
	const sameName = diff.files
		.map((f) => f.file.path)
		.filter((p) => p.split('/').at(-1) === name || p.endsWith(`/${stripped}`));
	return [...new Set([...exact, ...renamedFrom, ...sameName])].slice(0, MAX_SIMILAR);
}

/**
 * The path without what agents often put in front of one: `./`, a leading `/`,
 * or the `a/` and `b/` of a patch header.
 */
function withoutPrefix(path: string): string {
	const match = /^(?:\.\/|\/|[ab]\/)+/.exec(path);
	return match === null ? path : path.slice(match[0].length);
}

// --- Messages ------------------------------------------------------------------

/**
 * The most entries any one list in a message names; the rest are counted. An
 * agent's request can be long, and the message about it must stay short.
 */
const MAX_LISTED = 10;

/** The longest piece of the agent's own text a message repeats, in characters. */
const MAX_ECHOED = 80;

/** Items joined, the first `MAX_LISTED` of them, and how many more there are. */
function listed(items: readonly string[], separator = ', '): string {
	if (items.length <= MAX_LISTED) return items.join(separator);
	const more = items.length - MAX_LISTED;
	return `${items.slice(0, MAX_LISTED).join(separator)} and ${String(more)} more`;
}

/** Line ranges in the agent-facing form, at most `MAX_LISTED` of them. */
function listedRanges(ranges: readonly LineRange[]): string {
	return listed(ranges.map(formatLineRange), ',');
}

/** A file's hunk ids: `h1 to h400` when they are all of h1 to hN, otherwise a short list. */
function listedHunks(known: readonly HunkId[]): string {
	const sequential = known.every((id, i) => id === `h${String(i + 1)}`);
	if (known.length > MAX_LISTED && sequential) return `h1 to ${known.at(-1) ?? ''}`;
	return listed(known);
}

/** The agent's text, cut to `MAX_ECHOED` characters. */
function echoed(text: string): string {
	const chars = Array.from(text);
	return chars.length <= MAX_ECHOED ? text : `${chars.slice(0, MAX_ECHOED).join('')}…`;
}

/** The agent's text as a JSON string, cut to `MAX_ECHOED` characters. */
function quoted(text: string): string {
	return jsonQuoted(echoed(text));
}

const INVALID_ITEM_MESSAGES: Readonly<Record<InvalidItemProblem, string>> = {
	'no-target':
		'The item names nothing to assign. Give "file", "glob", "file" with "hunks", or "file" with "lines".',
	'glob-with-file':
		'A "glob" item cannot also have "file", "hunks" or "lines". Split it into two items.',
	'hunks-and-lines': 'An item can have "hunks" or "lines", not both. Split it into two items.',
	'no-file':
		'"hunks" and "lines" need the "file" they belong to, as in { "file": "src/app.ts", "lines": "+40..+62" }.',
	'empty-hunks':
		'"hunks" is empty. List hunk ids such as ["h1", "h2"], or leave it out to assign the whole file.',
	'nothing-to-do':
		'The item has no "section" and no "role", so it would change nothing. Add a "section" (a section id, or "ignored" with a "reason"), a "role", or both.',
	'reason-without-ignored':
		'"reason" only goes with "section": "ignored". Remove it, or use "section": "ignored" to ignore these lines.'
};

const LINES_PROBLEMS: Readonly<Record<MalformedLinesProblem, string>> = {
	empty: 'there is nothing there',
	unreadable: 'it is not a line label such as "+40" or "-38", nor "file"',
	'mixed-sides': 'the range starts on one side and ends on the other',
	'bad-range': 'the range ends before it starts, or a line number is below 1'
};

const SECTION_ID_PROBLEMS: Readonly<Record<InvalidSectionIdReason, string>> = {
	empty: 'it is empty',
	'too-long': 'it is longer than 64 characters',
	'not-a-slug': 'it is not a slug',
	reserved: 'it names a bucket'
};

/** Why an accepted item took nothing and what to do instead, written for the agent. */
export function describeNothingTaken(nothing: NothingTaken): TextForAgent {
	const target =
		nothing.target.kind === 'glob'
			? `The glob "${nothing.target.glob}"`
			: nothing.target.kind === 'file'
				? agentPath(nothing.target.path)
				: 'The item';
	const where = nothing.sortedInto.map(describeBucket).join(', ');
	const earlier = nothing.takenEarlierInCall ? ', some of it by an earlier item in this call' : '';
	return textForAgent(
		`${target} took nothing: everything in it is already sorted (into ${where})${earlier}. ` +
			'A whole file or a glob takes only what is still uncategorised, so it never undoes finer work. ' +
			'To move units that are already assigned, name them with "lines" or "hunks".'
	);
}

/** Which ranges of an accepted item took nothing, written for the agent. */
export function describeRangesTakingNothing(report: RangesTakingNothing): TextForAgent {
	const ranges = listedRanges(report.ranges);
	const one = report.ranges.length === 1;
	return textForAgent(
		`${agentPath(report.file)}: ${ranges} ${one ? 'holds' : 'hold'} no changed line and took nothing; the rest of the item was assigned. ` +
			'Nothing more needs doing unless you meant other lines; use the +/- labels from get_diff to name them.'
	);
}

/** What went wrong with an item and how to fix it, written for the agent. */
export function describeRejection(rejection: AssignRejection): TextForAgent {
	return textForAgent(rejectionText(rejection));
}

function rejectionText(rejection: AssignRejection): string {
	switch (rejection.kind) {
		case 'InvalidItem':
			return INVALID_ITEM_MESSAGES[rejection.problem];
		case 'UnknownFile':
			return rejection.similar.length > 0
				? `${quoted(rejection.file)} is not a changed file in this diff. Did you mean ${rejection.similar.map(agentPath).join(' or ')}?`
				: `${quoted(rejection.file)} is not a changed file in this diff. Use a path from get_manifest; a deleted file goes by its old path, any other file by its new path.`;
		case 'MalformedHunkId': {
			const bad = listed(rejection.hunks.map(quoted));
			const what = rejection.hunks.length === 1 ? 'is not a hunk id' : 'are not hunk ids';
			const ids =
				'Hunk ids are "h" and a number, as each hunk is labelled in get_diff ("@@ h1 -38,3 +38,4 @@").';
			return rejection.known.length > 0
				? `${bad} ${what}. ${ids} ${agentPath(rejection.file)} has hunks ${listedHunks(rejection.known)}.`
				: `${bad} ${what}. ${ids} ${agentPath(rejection.file)} has no hunks, because its change has no lines: assign the whole file instead.`;
		}
		case 'UnknownHunk':
			return rejection.known.length > 0
				? `${agentPath(rejection.file)} has no hunk ${listed(rejection.hunks)}. Its hunks are ${listedHunks(rejection.known)}.`
				: `${agentPath(rejection.file)} has no hunk ${listed(rejection.hunks)}: its change has no lines. Assign the whole file instead.`;
		case 'NoChangedLines': {
			const file = agentPath(rejection.file);
			const requested = listedRanges(rejection.ranges);
			const sides = new Set(rejection.ranges.map((r) => r.side));
			const nearestSides = new Set(rejection.nearest.map((r) => r.side));
			const missingSide = [...sides].find((side) => !nearestSides.has(side));
			const nearest =
				rejection.nearest.length === 0 ? '' : ` Nearby: ${formatLineRanges(rejection.nearest)}.`;
			if (missingSide !== undefined) {
				const name = missingSide === 'old' ? 'deleted' : 'added';
				const sign = missingSide === 'old' ? '-' : '+';
				return `${file} has no ${name} lines, so ${requested} takes nothing; "${sign}" labels ${name} lines. Its changed lines include ${formatLineRanges(rejection.nearest)}. Nothing was assigned for this item.`;
			}
			return `${file}: ${requested} ${rejection.ranges.length === 1 ? 'holds' : 'hold'} no changed line, so nothing was assigned for this item. A range takes the changed lines inside it and may span unchanged ones, but an item's ranges must hold at least one between them.${nearest} Use the +/- labels from get_diff.`;
		}
		case 'NoLinesInFile':
			return `${agentPath(rejection.file)} has no changed lines (it is binary, renamed, a mode change, a submodule or an empty file). Assign the whole file instead, or name its one change with "lines": "file".`;
		case 'NoFileUnit':
			return `${agentPath(rejection.file)} has no change to the file itself: its name, mode and kind are as they were, so "file" names nothing. Name its changed lines with their +/- labels instead. Nothing was assigned for this item.`;
		case 'MalformedLines':
			return `"lines" could not be read at ${quoted(rejection.part)}: ${LINES_PROBLEMS[rejection.problem]}. Write ranges such as "+40..+62,-38..-45", or "+40" for one line; "+" is the new side, "-" the old.`;
		case 'MalformedGlob':
			return `The glob ${quoted(rejection.glob)} is not valid: ${describeGlobProblem(rejection.problem)}. Nothing was assigned for this item.`;
		case 'GlobMatchesNothing':
			return `The glob ${quoted(rejection.glob)} matches no changed file. A pattern with a "/" is matched from the root; one without matches file names at any depth.`;
		case 'InvalidSectionId':
			return rejection.reason === 'reserved'
				? `${quoted(rejection.section)} is not a section id. To ignore lines, use "section": "ignored" with a "reason".`
				: `${quoted(rejection.section)} is not a valid section id: ${SECTION_ID_PROBLEMS[rejection.reason]}. Use a short slug of lowercase letters and digits joined by "-", "_" or ".", such as "session-expiry".`;
		case 'UnknownSection':
			return rejection.known.length > 0
				? `There is no section "${rejection.section}". Create it with upsert_sections first, or use one of: ${listed(rejection.known)}.`
				: `There is no section "${rejection.section}". Create it with upsert_sections first.`;
		case 'MissingReason':
			return 'Ignoring lines needs a "reason" saying why they need no review.';
		case 'InvalidReason':
			return rejection.problem === 'too-long'
				? `The "reason" is too long: keep it under ${String(MAX_AGENT_MARKDOWN_LENGTH)} characters, a sentence or two saying why these lines need no review.`
				: 'The "reason" is not well-formed text: it holds a lone UTF-16 surrogate, which cannot be stored or shown. Write it again as plain text.';
		case 'InvalidRole':
			return `${quoted(rejection.role)} is not a role. Use "code", "test" or "snapshot".`;
	}
}
