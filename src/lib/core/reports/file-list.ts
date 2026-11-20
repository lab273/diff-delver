/**
 * A diff's files as its page lists them before the full viewer exists: the
 * groups in reading order (the sections, then Ignored, then Not sorted yet), and
 * in each the files with a part in it, with the lines that part adds and removes
 * and, in Ignored, why. A file split between groups is listed in each, with the
 * lines of that group.
 */
import type { AgentMarkdown } from '../agent-markdown.tiny.ts';
import type { Diff } from '../diff/diff.ts';
import type { FileContent } from '../diff/file-diff.ts';
import { ignoreRuleName } from '../diff/path-rules.ts';
import { sectionView, type GroupKey, type Slice } from '../diff/slices.ts';
import type { AssignmentState, Assignment } from '../diff/state.ts';
import { escapedRepoPath, type EscapedPath } from '../escaped-path.tiny.ts';
import type { FileStatus } from '../file-status.tiny.ts';
import { parseLineCount, type LineCount } from '../line-count.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import { parseSectionTitle, type SectionTitle } from '../section-title.tiny.ts';
import type { Section } from './report.ts';

/** Why a file is ignored, as the list says it. The agent's reason is shown as the agent's. */
export type IgnoreReason =
	| { readonly kind: 'stated'; readonly text: ReviewerMessage }
	| { readonly kind: 'agent'; readonly reason: AgentMarkdown };

export interface ListedFile {
	readonly path: EscapedPath;
	readonly status: FileStatus;
	/** The path it had before, for a rename or a copy. */
	readonly from: EscapedPath | undefined;
	/** What kind of content changed: lines of text, or a whole binary file or submodule. */
	readonly content: FileContent['kind'];
	/** The lines added and removed in this group. */
	readonly added: LineCount;
	readonly removed: LineCount;
	/** In Ignored: why, each reason once. Empty elsewhere. */
	readonly ignored: readonly IgnoreReason[];
}

export type ListedGroup =
	| {
			readonly kind: 'section';
			readonly title: SectionTitle;
			readonly files: readonly ListedFile[];
	  }
	| { readonly kind: 'ignored'; readonly files: readonly ListedFile[] }
	| { readonly kind: 'uncategorised'; readonly files: readonly ListedFile[] };

function lineCount(n: number): LineCount {
	const parsed = parseLineCount(n);
	if (!parsed.ok) throw new RangeError(`Not a count of lines: ${n}`);
	return parsed.value;
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

function listedFile(slice: Slice): ListedFile {
	let added = 0;
	let removed = 0;
	const reasons: IgnoreReason[] = [];
	const note = (assignment: Assignment): void => {
		const reason = reasonOf(assignment);
		if (reason !== undefined && !reasons.some((r) => sameReason(r, reason))) reasons.push(reason);
	};
	switch (slice.kind) {
		case 'file':
			note(slice.assignment);
			break;
		case 'lines':
			for (const hunk of slice.hunks) {
				for (const line of hunk.lines) {
					if (line.kind !== 'own') continue;
					if (line.line.kind === 'added') added += 1;
					else removed += 1;
					note(line.assignment);
				}
			}
			break;
	}
	const file = slice.file;
	const renamed = file.status === 'renamed' || file.status === 'copied';
	return {
		path: escapedRepoPath(file.path),
		status: file.status,
		from: renamed && file.old !== undefined ? escapedRepoPath(file.old.path) : undefined,
		content: file.content.kind,
		added: lineCount(added),
		removed: lineCount(removed),
		ignored: reasons
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

/** The diff's groups with their files, in reading order. Empty groups are left out. */
export function listFiles(
	diff: Diff,
	state: AssignmentState,
	sections: readonly Section[]
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
		const listed = groupOf(group.key, group.slices.map(listedFile), titles);
		if (listed !== undefined) groups.push(listed);
	}
	return groups;
}
