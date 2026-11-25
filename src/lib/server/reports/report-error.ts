import { MAX_COMMENT_LENGTH } from '#lib/core/review/draft-comment.ts';
import type { ReviewNumber } from '#lib/core/review-number.tiny.ts';
/**
 * Everything the report service can fail with, each with a message for the
 * reviewer that says what happened and what to do next.
 */
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import type { DuplicateFilePath } from '#lib/core/diff/diff.ts';
import { describeDiffOutputError, type DiffOutputError } from '#lib/core/diff/diff-output-error.ts';
import { shownRepoPath } from '#lib/core/shown-path.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { describeSectionProblem, type SectionProblem } from '#lib/core/reports/section-requests.ts';
import { describeMarkError, type MarkError } from '#lib/core/review/mark-reviewed.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import {
	describeStoredStateMismatch,
	type StoredStateMismatch
} from '#lib/core/storage/stored-units.ts';
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import { describeDatabaseError, type DatabaseError } from '../db/index.ts';
import {
	describeLinesError,
	type FileIsBinary,
	type PathIsDirectory,
	type PathIsSubmodule,
	type PathNotFound
} from '../store/index.ts';
import { describeGitSourceError, type GitSourceError } from '../sources/git/index.ts';

/** No report has this id: it was deleted, or the link is wrong. */
export interface ReportNotFound {
	readonly kind: 'ReportNotFound';
	readonly report: ReportId;
}

/** The report is closed, so its breakdown and marks cannot change. */
export interface ReportClosed {
	readonly kind: 'ReportClosed';
	readonly report: ReportId;
}

/** A closed report cannot reopen while another report of the same source is open. */
export interface AnotherReportOpen {
	readonly kind: 'AnotherReportOpen';
	readonly report: ReportId;
	readonly open: ReportId;
}

/** A report with no revision, which the service never makes: the database was changed by hand. */
export interface ReportHasNoRevision {
	readonly kind: 'ReportHasNoRevision';
	readonly report: ReportId;
}

/** The folder the report was opened in now holds a different repository. */
export interface RepositoryReplaced {
	readonly kind: 'RepositoryReplaced';
	readonly path: AbsolutePath;
}

/**
 * A new revision of the report appeared each time a change was about to be
 * saved, so the change was not saved: it was made against a diff that is no
 * longer the report's current one.
 */
export interface RevisionChangedWhileSaving {
	readonly kind: 'RevisionChangedWhileSaving';
	readonly report: ReportId;
}

/**
 * A change was asked for on a version of the report that is no longer its
 * current one: the diff was updated after the caller last looked at it. Nothing
 * was changed, since the change was meant for what the caller saw.
 */
export interface VersionOutOfDate {
	readonly kind: 'VersionOutOfDate';
	readonly report: ReportId;
	/** The version the caller saw. */
	readonly seen: RevisionNumber;
	/** The report's current version. */
	readonly current: RevisionNumber;
}

/**
 * A change was asked for on a version newer than any the report has, which no
 * page or agent could have seen. Nothing was changed.
 */
export interface VersionNotFound {
	readonly kind: 'VersionNotFound';
	readonly report: ReportId;
	/** The version the caller named. */
	readonly seen: RevisionNumber;
	/** The report's current version, its newest. */
	readonly current: RevisionNumber;
}

/**
 * The report's saved snapshot is gone from the data folder (its store or its
 * snapshot was deleted or moved), so the report cannot be shown or changed.
 */
export interface SnapshotGone {
	readonly kind: 'SnapshotGone';
	readonly report: ReportId;
	/** The report's source in plain words. */
	readonly source: ReviewerMessage;
	/** Whether the report is still open, so that opening its source again replaces it. */
	readonly open: boolean;
}

/**
 * A part was asked for that the version does not have: its file has no changes
 * in that group. The page that asked shows a breakdown that has changed since.
 */
export interface PartNotFound {
	readonly kind: 'PartNotFound';
	readonly path: RepoPath;
}

/** `upsertSections` was refused; nothing changed. */
export interface SectionsRefused {
	readonly kind: 'SectionsRefused';
	readonly problems: readonly SectionProblem[];
}

export type ReportError =
	| DatabaseError
	| GitSourceError
	| DiffOutputError
	| StoredStateMismatch
	| DuplicateFilePath
	| MarkError
	| ReportNotFound
	| ReportClosed
	| AnotherReportOpen
	| ReportHasNoRevision
	| RepositoryReplaced
	| RevisionChangedWhileSaving
	| VersionOutOfDate
	| { readonly kind: 'SortingChanged' }
	| { readonly kind: 'AssignmentsChanged' }
	| VersionNotFound
	| SnapshotGone
	| SectionsRefused
	| PartNotFound
	| { readonly kind: 'InvalidCommentRange' }
	| { readonly kind: 'InvalidCommentBody' }
	/** The Delve's draft has no comment with that id: it was deleted, as from another tab. */
	| { readonly kind: 'CommentNotFound' }
	/** The comment's words were changed since the caller read it, as from another tab. */
	| { readonly kind: 'CommentChanged' }
	/** There is no comment in the draft, so there is no review to finish. */
	| { readonly kind: 'NothingToFinish' }
	/** The draft holds other comments, or other words, than the page that finished it showed. */
	| { readonly kind: 'DraftChanged' }
	/** The comments the page showed were finished since, as review `number`, as from another tab. */
	| { readonly kind: 'CommentsFinished'; readonly number: ReviewNumber }
	/** The comment was finished as part of review `number`, so it is no longer in the draft. */
	| { readonly kind: 'CommentFinished'; readonly number: ReviewNumber }
	/** The report has no finished review with that number. */
	| { readonly kind: 'ReviewNotFound'; readonly number: ReviewNumber }
	| PathNotFound
	| PathIsDirectory
	| PathIsSubmodule
	| FileIsBinary;

/** What happened and what to do next, for the reviewer. */
export function describeReportError(error: ReportError): ReviewerMessage {
	switch (error.kind) {
		case 'ReportNotFound':
			return reviewerMessage(
				'This Delve is not in diff delver any more: it may have been deleted. Go to the list of Delves to find the one you want, or open its changes again.'
			);
		case 'ReportClosed':
			return reviewerMessage(
				'This Delve is closed, so it can be read but not changed. Reopen it to carry on with it.'
			);
		case 'AnotherReportOpen':
			return reviewerMessage(
				'This Delve cannot be reopened while another Delve for the same changes is open. Carry on in that one, or close it first.'
			);
		case 'ReportHasNoRevision':
			return reviewerMessage(
				'This Delve has no saved version of its changes, so the database has been changed by hand or damaged. Delete it from the list of Delves and open its changes again.'
			);
		case 'RepositoryReplaced':
			return reviewerMessage(
				`${error.path} now holds a different repository from the one this Delve was opened in, so its changes cannot be checked. Open the changes again from the repository you want to review.`
			);
		case 'RevisionChangedWhileSaving':
			return reviewerMessage(
				'The Delve was updated while your change was being saved, so it was not saved: it was made on a version of the Delve that is no longer current. Reload the page to see the new version, then make the change again.'
			);
		case 'SortingChanged':
			return reviewerMessage(
				'The agent’s sorting changed. Check the refreshed section before marking it again.'
			);
		case 'AssignmentsChanged':
			return reviewerMessage(
				'The sections may have changed. Wait for the page to refresh them, then try again.'
			);
		case 'VersionOutOfDate':
			return reviewerMessage(
				`This Delve was updated to version ${String(error.current)} after you last looked at it, so nothing was changed: what you did was meant for version ${String(error.seen)}. Show the new version first, then do it again there.`
			);
		case 'VersionNotFound':
			return reviewerMessage(
				`This Delve has no version ${String(error.seen)}: its newest is version ${String(error.current)}, so nothing was changed. Reload the page to see the current version, then do it again there.`
			);
		case 'SnapshotGone':
			return reviewerMessage(
				error.open
					? `The saved copy of this Delve's changes is gone from diff delver's data folder (it was deleted or moved), so the diff cannot be shown. Open ${error.source} again to start a new Delve; this one will then be closed.`
					: `The saved copy of this Delve's changes is gone from diff delver's data folder (it was deleted or moved), so the diff cannot be shown, and nothing can bring it back. Delete it from the list of Delves.`
			);
		case 'SectionsRefused':
			return reviewerMessage(
				`The sections were not changed: ${error.problems.map(describeSectionProblem).join(' ')}`
			);
		case 'DuplicateFilePath':
			return reviewerMessage(
				`git listed ${shownRepoPath(error.path)} twice in one diff, which it never does, so diff delver read its output wrongly. Please report this as a bug.`
			);
		case 'StoredStateMismatch':
			return describeStoredStateMismatch(error);
		case 'InvalidCommentRange':
			return reviewerMessage(
				'Those lines are unavailable on that side of this file. Choose a range from the lines in the diff.'
			);
		case 'InvalidCommentBody':
			return reviewerMessage(`Write a comment of up to ${String(MAX_COMMENT_LENGTH)} characters.`);
		case 'CommentChanged':
			return reviewerMessage(
				'This comment’s words were changed since this page read them, perhaps in another tab, so nothing was changed here. Look at its words as they are now, then do it again if you still want to.'
			);
		case 'CommentNotFound':
			return reviewerMessage(
				'This comment is no longer in your draft: it was deleted, perhaps in another tab, so nothing was changed. If you still want what you wrote, copy it and write it as a new comment.'
			);
		case 'NothingToFinish':
			return reviewerMessage(
				'There is nothing to finish yet: your draft has no comments. Comment on a line by pressing its number, then finish the review.'
			);
		case 'DraftChanged':
			return reviewerMessage(
				'Your draft changed since this page showed it, perhaps in another tab, so the review was not finished. Look at what it will hand over now, then finish it again.'
			);
		case 'CommentsFinished':
			return reviewerMessage(
				`These comments were finished already, as review ${String(error.number)}, perhaps in another tab, so nothing more was finished. Review ${String(error.number)} is listed under Finished reviews, to copy or read.`
			);
		case 'CommentFinished':
			return reviewerMessage(
				`This comment was finished as part of review ${String(error.number)}, perhaps in another tab, so it can no longer be changed and nothing was changed. If you want to add to it, write a new comment: it starts the next review.`
			);
		case 'ReviewNotFound':
			return reviewerMessage(
				`This Delve has no review ${String(error.number)}. Its finished reviews are listed beside the draft.`
			);
		case 'PartNotFound':
			return reviewerMessage(
				`This part of ${shownRepoPath(error.path)} is not where the page showed it any more: the Delve was sorted again since. Reload the page to see where it is now.`
			);
		case 'PathNotFound':
		case 'PathIsDirectory':
		case 'PathIsSubmodule':
		case 'FileIsBinary':
			return describeLinesError(error);
		case 'FileNotInDiff':
		case 'NothingToMark':
			return describeMarkError(error);
		case 'MalformedRawListing':
		case 'MalformedPatch':
		case 'PatchCountMismatch':
		case 'PatchMismatch':
			return describeDiffOutputError(error);
		case 'DatabaseUnusable':
		case 'NotADatabase':
		case 'DatabaseCorrupt':
		case 'DatabaseTooNew':
		case 'MigrationFailed':
		case 'DatabaseBusy':
		case 'StoredRowInvalid':
		case 'DatabaseFailed':
			return describeDatabaseError(error);
		case 'UnresolvedConflict':
		case 'NoWorkingTree':
		case 'UnknownRevision':
		case 'NoCommitsYet':
		case 'ShallowHistory':
		case 'NoCommonHistory':
		case 'PartialCloneMissing':
		case 'GitNotFound':
		case 'GitTooOld':
		case 'NoSuchDirectory':
		case 'NotARepository':
		case 'DubiousOwnership':
		case 'BadRevision':
		case 'MissingObject':
		case 'GitFailed':
		case 'DataDirectoryUnusable':
		case 'StoreNotFound':
		case 'SnapshotNotFound':
		case 'StoreDamaged':
			return describeGitSourceError(error);
	}
}
