/**
 * Everything the report service can fail with, each with a message for the
 * reviewer that says what happened and what to do next.
 */
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import type { DuplicateFilePath } from '#lib/core/diff/diff.ts';
import { describeDiffOutputError, type DiffOutputError } from '#lib/core/diff/diff-output-error.ts';
import { escapedRepoPath } from '#lib/core/path-bytes.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { describeSectionProblem, type SectionProblem } from '#lib/core/reports/section-requests.ts';
import { describeMarkError, type MarkError } from '#lib/core/review/mark-reviewed.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import {
	describeStoredStateMismatch,
	type StoredStateMismatch
} from '#lib/core/storage/stored-units.ts';
import { describeDatabaseError, type DatabaseError } from '../db/index.ts';
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
	| SnapshotGone
	| SectionsRefused;

/** What happened and what to do next, for the reviewer. */
export function describeReportError(error: ReportError): ReviewerMessage {
	switch (error.kind) {
		case 'ReportNotFound':
			return reviewerMessage(
				`There is no report ${error.report}: it may have been deleted. Open the list of reports to find the one you want, or open the source again.`
			);
		case 'ReportClosed':
			return reviewerMessage(
				'This report is closed, so it can be read but not changed. Reopen it to carry on with it.'
			);
		case 'AnotherReportOpen':
			return reviewerMessage(
				`This report cannot be reopened while another report of the same changes is open (${error.open}). Carry on in that one, or close it first.`
			);
		case 'ReportHasNoRevision':
			return reviewerMessage(
				`Report ${error.report} has no saved snapshot of its changes, so the database has been changed by hand or damaged. Delete the report and open the source again.`
			);
		case 'RepositoryReplaced':
			return reviewerMessage(
				`${error.path} now holds a different repository from the one this report was opened in, so its changes cannot be checked. Open the source again from the repository you want to review.`
			);
		case 'RevisionChangedWhileSaving':
			return reviewerMessage(
				'The diff was updated while your change was being saved, so it was not saved: it was made on a version of the diff that is no longer current. Reload the page to see the new version, then make the change again.'
			);
		case 'SnapshotGone':
			return reviewerMessage(
				error.open
					? `The saved copy of this report's changes is gone from diff delver's data folder (it was deleted or moved), so the report cannot be shown. Open ${error.source} again to start a new report of them; this one will then be closed.`
					: `The saved copy of this report's changes is gone from diff delver's data folder (it was deleted or moved), so the report cannot be shown, and nothing can bring it back. Delete it from the list of reports.`
			);
		case 'SectionsRefused':
			return reviewerMessage(
				`The sections were not changed: ${error.problems.map(describeSectionProblem).join(' ')}`
			);
		case 'DuplicateFilePath':
			return reviewerMessage(
				`git listed ${escapedRepoPath(error.path)} twice in one diff, which it never does, so diff delver read its output wrongly. Please report this as a bug.`
			);
		case 'StoredStateMismatch':
			return describeStoredStateMismatch(error);
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
