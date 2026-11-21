/**
 * Choosing commits to review (DESIGN 3.1): a diff is always between two points
 * of history, so the commits chosen are always one unbroken run of a branch's
 * list, newest first along first parents.
 *
 * The rule a person discovers by ticking:
 *
 * - Ticking a commit when none is ticked chooses it alone.
 * - Ticking another chooses every commit between the two as well: the run
 *   grows to reach it.
 * - Unticking the newest or the oldest commit of the run shrinks it by one.
 * - Unticking one in the middle keeps the newer part, above it in the list, and
 *   unticks the older commits below it, since commits that are not next to each
 *   other cannot be one diff. Only then does the page say why.
 *
 * One commit opens as the `commit` source. A run opens as a `range` from the
 * parent of its oldest commit to its newest, written as commit ids. When the
 * oldest is the repository's first commit there is no parent: the range starts
 * from git's empty tree, as the `commit` source does for a first commit. The
 * diff it opens is titled by its commits (`commit-run.ts`).
 */
import type { CommitId } from '../commit-id.tiny.ts';
import { itemIndexAt, type ItemIndex } from '../item-index.tiny.ts';
import { EMPTY_TREE } from '../object-format.ts';
import { err, ok, type Result } from '../result.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import { parseRevision, type Revision } from '../revision.tiny.ts';
import type { GitSourceSpec } from '../sources/git-source-spec.ts';
import { describeDiffSize } from '../reports/describe-report.ts';
import type { DiffSize } from '../reports/report.ts';
import { formatCount } from '../viewer/words.ts';
import { commitCountOf, type CommitCount } from './commit-count.tiny.ts';
import { quotedSubject } from './commit-run.ts';
import type { SubjectLine } from './subject-line.tiny.ts';

/** What a commit is compared with when it is reviewed: its first parent, or nothing before it. */
export type CommitParent =
	| { readonly kind: 'commit'; readonly commit: CommitId }
	/** The repository's first commit, or one of them: compared with an empty tree. */
	| { readonly kind: 'none' }
	/** A shallow clone stops here: its parent was never downloaded. */
	| { readonly kind: 'not-downloaded' };

/** What the rule needs of one row of the list. */
export interface ChoosableCommit {
	readonly commit: CommitId;
	readonly subject: SubjectLine;
	readonly parent: CommitParent;
}

export type CommitSelection =
	| { readonly kind: 'none' }
	/** Rows `newest` to `oldest` of the list, both included; `newest` is never below `oldest`. */
	| { readonly kind: 'run'; readonly newest: ItemIndex; readonly oldest: ItemIndex };

export const NOTHING_SELECTED: CommitSelection = { kind: 'none' };

/** What a tick or an untick did. */
export interface Toggled {
	readonly selection: CommitSelection;
	/** Older commits unticked with a commit from the middle of the run; zero otherwise. */
	readonly cut: CommitCount;
}

function run(newest: number, oldest: number): CommitSelection {
	return { kind: 'run', newest: itemIndexAt(newest), oldest: itemIndexAt(oldest) };
}

export function isSelected(selection: CommitSelection, row: ItemIndex): boolean {
	return selection.kind === 'run' && selection.newest <= row && row <= selection.oldest;
}

/** How many commits are chosen. */
export function selectedCount(selection: CommitSelection): CommitCount {
	return commitCountOf(selection.kind === 'run' ? selection.oldest - selection.newest + 1 : 0);
}

/** Ticks a row: the run grows to reach it. Ticking a chosen row changes nothing. */
export function tick(selection: CommitSelection, row: ItemIndex): CommitSelection {
	if (selection.kind === 'none') return run(row, row);
	return run(Math.min(selection.newest, row), Math.max(selection.oldest, row));
}

/** Unticks a row; one in the middle of the run unticks the older rows below it too. */
export function untick(selection: CommitSelection, row: ItemIndex): Toggled {
	const none = commitCountOf(0);
	if (selection.kind === 'none' || !isSelected(selection, row)) return { selection, cut: none };
	const { newest, oldest } = selection;
	if (newest === oldest) return { selection: NOTHING_SELECTED, cut: none };
	if (row === newest) return { selection: run(newest + 1, oldest), cut: none };
	if (row === oldest) return { selection: run(newest, oldest - 1), cut: none };
	return { selection: run(newest, row - 1), cut: commitCountOf(oldest - row) };
}

/** What pressing a row's tick box does: ticks it, or unticks it. */
export function toggle(selection: CommitSelection, row: ItemIndex): Toggled {
	return isSelected(selection, row)
		? untick(selection, row)
		: { selection: tick(selection, row), cut: commitCountOf(0) };
}

/** Why the chosen commits cannot be opened. */
export type SelectionProblem =
	| { readonly kind: 'NothingSelected' }
	/** The oldest commit's parent is not in this shallow clone, so there is nothing to compare it with. */
	| { readonly kind: 'HistoryNotDownloaded'; readonly commit: CommitId };

function revisionOf(id: string): Revision {
	const parsed = parseRevision(id);
	if (!parsed.ok) throw new Error(`An object id is not a revision: ${id}`);
	return parsed.value;
}

/**
 * The source that reviews the chosen commits: the commit alone, or the range
 * from its oldest commit's parent (or the empty tree) to its newest. `rows` is
 * the list the selection was made in.
 */
export function selectionSource(
	rows: readonly ChoosableCommit[],
	selection: CommitSelection
): Result<GitSourceSpec, SelectionProblem> {
	if (selection.kind === 'none') return err({ kind: 'NothingSelected' });
	const newest = rows[selection.newest];
	const oldest = rows[selection.oldest];
	if (newest === undefined || oldest === undefined) return err({ kind: 'NothingSelected' });
	if (selection.newest === selection.oldest) {
		return ok({ kind: 'commit', revision: revisionOf(newest.commit) });
	}
	switch (oldest.parent.kind) {
		case 'commit':
			return ok({
				kind: 'range',
				from: revisionOf(oldest.parent.commit),
				to: revisionOf(newest.commit)
			});
		case 'none': {
			const tree = newest.commit.length === 64 ? EMPTY_TREE.sha256 : EMPTY_TREE.sha1;
			return ok({ kind: 'range', from: revisionOf(tree), to: revisionOf(newest.commit) });
		}
		case 'not-downloaded':
			return err({ kind: 'HistoryNotDownloaded', commit: oldest.commit });
	}
}

/**
 * The chosen commits in words, with the size of the diff they make when it is
 * known: "4 commits, from “Add the cart” to “Fix the total”: 12 files changed,
 * 340 lines added and 25 removed".
 */
export function describeSelection(
	rows: readonly ChoosableCommit[],
	selection: CommitSelection,
	size: DiffSize | undefined
): ReviewerMessage {
	if (selection.kind === 'none') {
		return reviewerMessage(
			'No commits ticked yet. Tick one to review it; tick another to review every commit from one to the other.'
		);
	}
	const newest = rows[selection.newest];
	const oldest = rows[selection.oldest];
	if (newest === undefined || oldest === undefined) return reviewerMessage('');
	const count = selectedCount(selection);
	const what =
		count === 1
			? `1 commit, ${quotedSubject(newest.subject)}`
			: `${formatCount(count)} commits, from ${quotedSubject(oldest.subject)} to ${quotedSubject(newest.subject)}`;
	return reviewerMessage(size === undefined ? what : `${what}: ${describeDiffSize(size)}`);
}

/** What the button that opens the chosen commits says. */
export function describeReviewButton(selection: CommitSelection): ReviewerMessage {
	const count = selectedCount(selection);
	if (count === 0) return reviewerMessage('Review the ticked commits');
	return reviewerMessage(
		count === 1 ? 'Review this commit' : `Review these ${formatCount(count)} commits`
	);
}

/** Why some commits were unticked with the one a person unticked. */
export function describeCut(cut: CommitCount): ReviewerMessage | undefined {
	if (cut === 0) return undefined;
	const older =
		cut === 1
			? 'the older commit below it was'
			: `the ${formatCount(cut)} older commits below it were`;
	return reviewerMessage(
		`Only commits next to each other can be reviewed as one diff, so ${older} unticked too.`
	);
}

/** Why the chosen commits cannot be opened, and what to do instead. */
export function describeSelectionProblem(problem: SelectionProblem): ReviewerMessage {
	switch (problem.kind) {
		case 'NothingSelected':
			return reviewerMessage('Tick a commit first, then review it.');
		case 'HistoryNotDownloaded':
			return reviewerMessage(
				`This is a shallow clone, and the history before commit ${problem.commit.slice(0, 7)} was not downloaded, so there is nothing to compare it with. Untick it, or download more history with "git fetch --deepen=50", then reload this page.`
			);
	}
}
