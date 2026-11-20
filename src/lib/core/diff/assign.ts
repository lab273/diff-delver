/**
 * `assign` (DESIGN 7.1): puts change units in a section or in `Ignored`, and
 * optionally sets their role.
 *
 * Each item names a target and what to do with it:
 *
 * - A whole file or a glob of files takes only what is still uncategorised in
 *   those files, so it never undoes earlier, finer work.
 * - Hunk ids or line ranges within a file move exactly those units, wherever they
 *   were: the last write wins.
 * - An item with a role and no section sets the role of every unit it targets,
 *   and leaves their buckets alone. With a section, the role is set on the units
 *   the item takes.
 *
 * Items apply in order, each all or nothing: a valid item applies even when
 * another in the same call is rejected, and a rejected item changes nothing.
 * The input state is never changed.
 */
import { parseAgentMarkdown, type AgentMarkdown } from '../agent-markdown.tiny.ts';
import { compileGlob, parseGlobPattern, type GlobPattern } from '../glob-pattern.tiny.ts';
import { describeGlobProblem, type GlobProblem } from '../glob.ts';
import { parseHunkId, type HunkId } from '../hunk-id.tiny.ts';
import { formatLineRanges, lineRangesOf, type LineRange } from '../line-range.ts';
import { RangeSet } from '../range-set.ts';
import { itemIndexAt, type ItemIndex } from '../item-index.tiny.ts';
import { unescapeRepoPath } from '../path-bytes.ts';
import { textForAgent, type TextForAgent } from '../text-for-agent.tiny.ts';
import { addUnits, NO_UNITS, ONE_UNIT, unitCountOf, type UnitCount } from '../unit-count.tiny.ts';
import { parseRepoPath, type RepoPath } from '../repo-path.tiny.ts';
import { err, ok, type Result } from '../result.ts';
import { parseRole, type Role } from '../role.tiny.ts';
import { parseSectionId, type InvalidSectionIdReason, type SectionId } from '../section-id.tiny.ts';
import type { Side } from '../side.tiny.ts';
import { agentPath } from './agent-text.ts';
import { ignoredBucket, sectionBucket, type Bucket } from './bucket.ts';
import type { Diff, DiffFile, SideLines } from './diff.ts';
import { parseLineSpec, type MalformedLinesProblem } from './line-spec.ts';
import { countUncategorised } from './totals.ts';
import {
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
	/** Line ranges such as `+40..+62,-38..-45`. */
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
	| { readonly kind: 'lines'; readonly path: RepoPath; readonly ranges: readonly LineRange[] };

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
			readonly kind: 'UnknownHunk';
			readonly file: RepoPath;
			readonly hunks: readonly string[];
			readonly known: readonly HunkId[];
	  }
	| {
			readonly kind: 'NotChangedLines';
			readonly file: RepoPath;
			/** The requested lines that are not changed lines. */
			readonly notChanged: readonly LineRange[];
			/** Every changed line of the file, for reference. */
			readonly changed: readonly LineRange[];
	  }
	| {
			/** Line ranges were given for a file whose change has no lines (binary, rename, ...). */
			readonly kind: 'NoLinesInFile';
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
	| { readonly kind: 'InvalidRole'; readonly role: string };

// --- Outcome -------------------------------------------------------------------

export interface AssignOptions {
	/** When given, a section must be one of these. */
	readonly knownSections?: ReadonlySet<SectionId>;
}

export interface AssignOutcome {
	readonly state: AssignmentState;
	/** Each applied item by its position in the request, and how many units it took. */
	readonly accepted: readonly { readonly index: ItemIndex; readonly units: UnitCount }[];
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
	const parsed = requests.map(parseAssignRequest);
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
	const accepted: { index: ItemIndex; units: UnitCount }[] = [];
	const rejected: { index: ItemIndex; rejection: AssignRejection }[] = [];
	items.forEach((item, position) => {
		const index = itemIndexAt(position);
		const applied = item.ok ? applyItem(diff, current, item.value, options) : item;
		if (applied.ok) {
			current = applied.value.state;
			accepted.push({ index, units: applied.value.units });
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
		if (!reason.ok) return err({ kind: 'MissingReason' });
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
			return err({ kind: 'UnknownHunk', file: path.value, hunks: bad, known: [] });
		return ok({ kind: 'hunks', path: path.value, hunks: ids });
	}
	if (lines !== undefined) {
		const ranges = parseLineSpec(lines);
		if (!ranges.ok) return err(ranges.error);
		return ok({ kind: 'lines', path: path.value, ranges: ranges.value });
	}
	return ok({ kind: 'file', path: path.value });
}

// --- Applying an item ----------------------------------------------------------

/** The units of one file that an item targets. */
type FileTarget =
	{ readonly kind: 'whole' } | { readonly kind: 'lines'; readonly lines: SideLines };

interface Applied {
	readonly state: AssignmentState;
	readonly units: UnitCount;
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
	for (const [file, target] of targets.value) {
		const updated = applyToFile(fileAssignment(state, file), target, onlyUncategorised, change);
		files.set(file.file.path, updated.assignment);
		units = addUnits(units, updated.units);
	}
	return ok({ state: { files }, units });
}

function destinationBucket(destination: Destination): Bucket {
	switch (destination.kind) {
		case 'section':
			return sectionBucket(destination.section);
		case 'ignored':
			return ignoredBucket({ kind: 'agent', reason: destination.reason });
	}
}

function applyToFile(
	assignment: FileAssignment,
	target: FileTarget,
	onlyUncategorised: boolean,
	change: (a: Assignment) => Assignment
): { readonly assignment: FileAssignment; readonly units: UnitCount } {
	const takes = (a: Assignment): boolean => !onlyUncategorised || a.bucket.kind === 'uncategorised';
	switch (assignment.kind) {
		case 'file': {
			if (!takes(assignment.assignment)) return { assignment, units: NO_UNITS };
			return {
				assignment: { kind: 'file', assignment: change(assignment.assignment) },
				units: ONE_UNIT
			};
		}
		case 'lines': {
			let units = NO_UNITS;
			const sides = { old: assignment.old, new: assignment.new };
			for (const side of ['old', 'new'] as const) {
				const map = sides[side];
				const wanted = target.kind === 'whole' ? map.domain : target.lines[side];
				const taken = RangeSet.fromIntervals(map.within(wanted).filter((s) => takes(s.value)));
				units = addUnits(units, unitCountOf(taken.size));
				sides[side] = map.update(taken, change);
			}
			return { assignment: { kind: 'lines', ...sides }, units };
		}
	}
}

function resolveTarget(
	diff: Diff,
	target: AssignTarget
): Result<ReadonlyMap<DiffFile, FileTarget>, AssignRejection> {
	switch (target.kind) {
		case 'file': {
			const file = findFile(diff, target.path);
			return file.ok ? ok(new Map([[file.value, { kind: 'whole' } as const]])) : file;
		}
		case 'glob': {
			const matches = compileGlob(target.glob);
			const files = diff.files.filter((f) => matches(f.file.path));
			if (files.length === 0) return err({ kind: 'GlobMatchesNothing', glob: target.glob });
			return ok(new Map(files.map((f) => [f, { kind: 'whole' } as const])));
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
			return ok(new Map([[file.value, { kind: 'lines', lines: { old, new: now } } as const]]));
		}
		case 'lines': {
			const file = findFile(diff, target.path);
			if (!file.ok) return file;
			if (!file.value.hasLines) return err({ kind: 'NoLinesInFile', file: target.path });
			const wanted = linesOf(target.ranges);
			const notChanged = [
				...lineRangesOf('old', wanted.old.subtract(file.value.changed.old)),
				...lineRangesOf('new', wanted.new.subtract(file.value.changed.new))
			];
			if (notChanged.length > 0) {
				return err({
					kind: 'NotChangedLines',
					file: target.path,
					notChanged,
					changed: [
						...lineRangesOf('old', file.value.changed.old),
						...lineRangesOf('new', file.value.changed.new)
					]
				});
			}
			return ok(new Map([[file.value, { kind: 'lines', lines: wanted } as const]]));
		}
	}
}

function linesOf(ranges: readonly LineRange[]): SideLines {
	const side = (s: Side): RangeSet => RangeSet.fromIntervals(ranges.filter((r) => r.side === s));
	return { old: side('old'), new: side('new') };
}

const MAX_SIMILAR = 5;

function findFile(diff: Diff, path: RepoPath): Result<DiffFile, AssignRejection> {
	for (const candidate of pathsMeant(path)) {
		const parsed = parseRepoPath(candidate);
		const file = parsed.ok ? diff.byPath.get(parsed.value) : undefined;
		if (file !== undefined) return ok(file);
	}
	return err({ kind: 'UnknownFile', file: path, similar: similarPaths(diff, path) });
}

/**
 * The paths a `file` value can stand for, in order: the value itself; the path
 * whose escaped form it is, for a path that is not UTF-8 (`path-bytes.ts`); and
 * both again for what a JSON string holds, when the agent sent the quoted form
 * from the agent text, quotes and all.
 */
function pathsMeant(text: string): readonly string[] {
	const meant = [text];
	const unescaped = unescapeRepoPath(text);
	if (unescaped !== undefined) meant.push(unescaped);
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
	const name = path.split('/').at(-1) ?? path;
	const renamedFrom = diff.files.filter((f) => f.file.old?.path === path).map((f) => f.file.path);
	const sameName = diff.files
		.map((f) => f.file.path)
		.filter((p) => p.split('/').at(-1) === name || p.endsWith(`/${path}`));
	return [...new Set([...renamedFrom, ...sameName])].slice(0, MAX_SIMILAR);
}

// --- Messages ------------------------------------------------------------------

const INVALID_ITEM_MESSAGES: Readonly<Record<InvalidItemProblem, string>> = {
	'no-target':
		'The item names nothing to assign. Give "file", "glob", "file" with "hunks", or "file" with "lines".',
	'glob-with-file':
		'A "glob" item cannot also have "file", "hunks" or "lines". Split it into two items.',
	'hunks-and-lines': 'An item can have "hunks" or "lines", not both. Split it into two items.',
	'no-file': '"hunks" and "lines" need the "file" they belong to.',
	'empty-hunks':
		'"hunks" is empty. List hunk ids such as ["h1", "h2"], or leave it out to assign the whole file.',
	'nothing-to-do': 'The item has no "section" and no "role", so it would change nothing.',
	'reason-without-ignored': '"reason" only goes with "section": "ignored".'
};

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
				? `${JSON.stringify(rejection.file)} is not a changed file in this diff. Did you mean ${rejection.similar.map(agentPath).join(' or ')}?`
				: `${JSON.stringify(rejection.file)} is not a changed file in this diff. Use a path from get_manifest; a deleted file goes by its old path, any other file by its new path.`;
		case 'UnknownHunk':
			return rejection.known.length > 0
				? `${agentPath(rejection.file)} has no hunk ${rejection.hunks.join(', ')}. Its hunks are ${rejection.known.join(', ')}.`
				: `${agentPath(rejection.file)} has no hunk ${rejection.hunks.join(', ')}: its change has no lines. Assign the whole file instead.`;
		case 'NotChangedLines':
			return `${agentPath(rejection.file)}: ${formatLineRanges(rejection.notChanged)} are not changed lines, so they cannot be assigned. The changed lines are ${formatLineRanges(rejection.changed)}. Use the +/- labels from get_diff.`;
		case 'NoLinesInFile':
			return `${agentPath(rejection.file)} has no changed lines (it is binary, renamed, a mode change, a submodule or an empty file). Assign the whole file instead.`;
		case 'MalformedLines':
			return `"lines" could not be read at "${rejection.part}" (${rejection.problem}). Write ranges such as "+40..+62,-38..-45", or "+40" for one line.`;
		case 'MalformedGlob':
			return `The glob "${rejection.glob}" is not valid: ${describeGlobProblem(rejection.problem)}. Nothing was assigned for this item.`;
		case 'GlobMatchesNothing':
			return `The glob "${rejection.glob}" matches no changed file. A pattern with a "/" is matched from the root; one without matches file names at any depth.`;
		case 'InvalidSectionId':
			return rejection.reason === 'reserved'
				? `"${rejection.section}" is not a section id. To ignore lines, use "section": "ignored" with a "reason".`
				: `"${rejection.section}" is not a valid section id (${rejection.reason}). Use a short slug of lowercase letters, digits and dashes, such as "session-expiry".`;
		case 'UnknownSection':
			return rejection.known.length > 0
				? `There is no section "${rejection.section}". Create it with upsert_sections first, or use one of: ${rejection.known.join(', ')}.`
				: `There is no section "${rejection.section}". Create it with upsert_sections first.`;
		case 'MissingReason':
			return 'Ignoring lines needs a "reason" saying why they need no review.';
		case 'InvalidRole':
			return `"${rejection.role}" is not a role. Use "code", "test" or "snapshot".`;
	}
}
