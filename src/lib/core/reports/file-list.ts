/**
 * A diff's files as its page lists them before the full viewer exists: the
 * groups in reading order (the sections, then Ignored, then Not sorted yet), and
 * in each the files with a part in it, with the lines that part adds and removes
 * and, in Ignored, why. A file split between groups is listed in each, with the
 * lines of that group.
 */
import { EMPTY_UNIT_SET, fileUnitInSet, linesInSet, type UnitSet } from '../diff/unit-set.ts';
import { unitCountOf, type UnitCount } from '../unit-count.tiny.ts';
import type { AgentMarkdown } from '../agent-markdown.tiny.ts';
import type { Diff } from '../diff/diff.ts';
import { describeFileChange, describeFileLines, describeFileUnit } from '../diff/file-unit.ts';
import { ignoreRuleName } from '../diff/path-rules.ts';
import { sectionView, type GroupKey, type Slice } from '../diff/slices.ts';
import type { AssignmentState, Assignment } from '../diff/state.ts';
import { escapedRepoPath, type EscapedPath } from '../escaped-path.tiny.ts';
import { lineCountOf, type LineCount } from '../line-count.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import { parseSectionTitle, type SectionTitle } from '../section-title.tiny.ts';
import type { Section } from './report.ts';

/** Why a file is ignored, as the list says it. The agent's reason is shown as the agent's. */
export type IgnoreReason =
	| { readonly kind: 'stated'; readonly text: ReviewerMessage }
	| { readonly kind: 'agent'; readonly reason: AgentMarkdown };

export interface ListedFile {
	readonly path: EscapedPath;
	/**
	 * How the file changed, in plain words: "changed", "added", "renamed from
	 * src/old.ts", "changed, made executable", "added, binary file". Only what is
	 * in this group: "made executable" where only that waits, "changed" where
	 * only its lines are.
	 */
	readonly change: ReviewerMessage;
	/** The lines added and removed in this group. */
	readonly added: LineCount;
	readonly removed: LineCount;
	/** In Ignored: why, each reason once. Empty elsewhere. */
	readonly ignored: readonly IgnoreReason[];
	/**
	 * How many of its units in this group are new since the previous version
	 * and to be reviewed; 0 in Ignored and in a first version.
	 */
	readonly newChanges: UnitCount;
}

export type ListedGroup =
	| {
			readonly kind: 'section';
			readonly title: SectionTitle;
			readonly files: readonly ListedFile[];
	  }
	| { readonly kind: 'ignored'; readonly files: readonly ListedFile[] }
	| { readonly kind: 'uncategorised'; readonly files: readonly ListedFile[] };

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

/** Whether a file's change has lines at all, in this group or another. */
function hasLinesAnywhere(file: Slice['file']): boolean {
	return file.content.kind === 'text' && file.content.hunks.length > 0;
}

function listedFile(slice: Slice, fresh: UnitSet): ListedFile {
	let added = 0;
	let removed = 0;
	let newChanges = 0;
	const path = slice.file.path;
	const freshOld = linesInSet(fresh, path, 'old');
	const freshNew = linesInSet(fresh, path, 'new');
	const reasons: IgnoreReason[] = [];
	const note = (assignment: Assignment): void => {
		const reason = reasonOf(assignment);
		if (reason !== undefined && !reasons.some((r) => sameReason(r, reason))) reasons.push(reason);
	};
	if (slice.fileUnit !== undefined) {
		note(slice.fileUnit);
		if (slice.fileUnit.bucket.kind !== 'ignored' && fileUnitInSet(fresh, path)) newChanges += 1;
	}
	for (const hunk of slice.hunks) {
		for (const line of hunk.lines) {
			if (line.kind !== 'own') continue;
			const isNew =
				line.line.kind === 'added' ? freshNew.has(line.line.new) : freshOld.has(line.line.old);
			if (line.line.kind === 'added') added += 1;
			else removed += 1;
			if (isNew && line.assignment.bucket.kind !== 'ignored') newChanges += 1;
			note(line.assignment);
		}
	}
	const file = slice.file;
	// Only what waits in this group: a file's lines and the change to the file itself may be apart.
	const hasLines = added + removed > 0;
	const change =
		slice.fileUnit === undefined
			? describeFileLines(file)
			: hasLines || !hasLinesAnywhere(file)
				? describeFileChange(file)
				: describeFileUnit(file);
	return {
		path: escapedRepoPath(file.path),
		change,
		added: lineCountOf(added),
		removed: lineCountOf(removed),
		ignored: reasons,
		newChanges: unitCountOf(newChanges)
	};
}

function groupOf(
	key: GroupKey,
	files: readonly ListedFile[],
	titles: ReadonlyMap<string, SectionTitle>
): ListedGroup | undefined {
	switch (key.kind) {
		case 'section': {
			// A section the state uses but the list lacks is shown by its id, never dropped.
			const title = titles.get(key.section) ?? parseSectionTitle(key.section);
			if (typeof title === 'string') return { kind: 'section', title, files };
			if (!title.ok) throw new Error(`A section id is not a title: ${key.section}`);
			return { kind: 'section', title: title.value, files };
		}
		case 'tests':
			// Only the tests-separate view has these; this list is of the sections view.
			return undefined;
		case 'ignored':
			return { kind: 'ignored', files };
		case 'uncategorised':
			return { kind: 'uncategorised', files };
	}
}

/**
 * The diff's groups with their files, in reading order. Empty groups are left
 * out. `fresh` is the units new since the previous version, which each file
 * counts.
 */
export function listFiles(
	diff: Diff,
	state: AssignmentState,
	sections: readonly Section[],
	fresh: UnitSet = EMPTY_UNIT_SET
): readonly ListedGroup[] {
	const titles = new Map<string, SectionTitle>(sections.map((s) => [s.id, s.title]));
	const view = sectionView(
		diff,
		state,
		sections.map((s) => s.id)
	);
	const groups: ListedGroup[] = [];
	for (const group of view.groups) {
		if (group.slices.length === 0) continue;
		const listed = groupOf(
			group.key,
			group.slices.map((slice) => listedFile(slice, fresh)),
			titles
		);
		if (listed !== undefined) groups.push(listed);
	}
	return groups;
}
