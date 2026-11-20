/**
 * Reports in plain words (DESIGN 8.5), for the reports list and the report's
 * own page, and the size of a diff as the list shows it.
 */
import type { AbsolutePath } from '../absolute-path.tiny.ts';
import { fileCountOf } from '../file-count.tiny.ts';
import { parseLineCount, type LineCount } from '../line-count.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import { describeGitSource, type GitSourceSpec } from '../sources/git-source-spec.ts';
import type { Diff } from '../diff/diff.ts';
import type { ClosedReason, DiffSize, ReportSource } from './report.ts';

/** The report's title: its source in plain words, such as "Uncommitted changes". */
export function reportTitle(source: ReportSource): ReviewerMessage {
	// One kind of source so far; jj and GitHub will add their own titles.
	return describeGitSource(source.spec);
}

/**
 * The repository as people name it: its folder, such as "diff-delver". For a
 * git directory with no worktree, the folder of the git directory, or the one
 * around it when it is called `.git`.
 */
export function repositoryLabel(path: AbsolutePath): ReviewerMessage {
	const parts = path.split('/').filter((part) => part !== '');
	const last = parts.at(-1);
	const label = last === '.git' ? parts.at(-2) : last;
	return reviewerMessage(label ?? path);
}

/** Why a report is closed, as a sentence. */
export function describeClosedReason(reason: ClosedReason): ReviewerMessage {
	switch (reason) {
		case 'reviewer':
			return reviewerMessage('You closed this report.');
		case 'source-empty':
			return reviewerMessage(
				'Closed when its source was opened again with nothing left to review: the changes had been committed, merged or discarded.'
			);
		case 'snapshot-gone':
			return reviewerMessage(
				"Closed because diff delver's saved copy of its changes was gone from the data folder, so it could not be shown; opening its source again started a new report in its place. Delete this one; nothing in it can be shown."
			);
	}
}

/** Why a source has nothing to review, and what to do instead. */
export function describeNothingToReview(spec: GitSourceSpec): ReviewerMessage {
	switch (spec.kind) {
		case 'working-tree':
			return reviewerMessage(
				'There are no uncommitted changes: every file is as it was in the last commit. Change some files, or review a commit or a branch instead.'
			);
		case 'staged':
			return reviewerMessage(
				'Nothing is staged: the index is the same as the last commit. Stage some changes with "git add", or review the uncommitted changes instead.'
			);
		case 'commit':
			return reviewerMessage(
				'This commit changes no files, so there is nothing to review. Choose another commit, or compare two branches instead.'
			);
		case 'range':
			return reviewerMessage(
				'There are no differences between these two: the second has no changes since they parted. Check that these are the two branches you meant.'
			);
	}
}

function lineCount(n: number): LineCount {
	const parsed = parseLineCount(n);
	if (!parsed.ok) throw new RangeError(`Not a count of lines: ${n}`);
	return parsed.value;
}

/** How many files a diff changes, and how many lines it adds and deletes. */
export function diffSizeOf(diff: Diff): DiffSize {
	let added = 0;
	let deleted = 0;
	for (const file of diff.files) {
		added += file.changed.new.size;
		deleted += file.changed.old.size;
	}
	return {
		files: fileCountOf(diff.files.length),
		addedLines: lineCount(added),
		deletedLines: lineCount(deleted)
	};
}
