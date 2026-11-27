/**
 * The report service's errors, as an agent is told them: in terms of the tool
 * call, and what to call instead. Errors only the person can act on, such as
 * a damaged database, are the reviewer's message, which says what to do.
 */
import { describeStepProblem } from '#lib/core/reports/reading-order.ts';
import { describeSectionProblem } from '#lib/core/reports/section-requests.ts';
import { describeNoteProblem } from '#lib/core/review/agent-note.ts';
import { textForAgent, type TextForAgent } from '#lib/core/text-for-agent.tiny.ts';
import { describeReportError, type ReportError } from '../reports/index.ts';

export function describeForAgent(error: ReportError): TextForAgent {
	switch (error.kind) {
		case 'VersionOutOfDate':
			return textForAgent(
				`The diff changed since you read it: you sent "version": ${String(error.seen)}, and the report is at version ${String(error.current)} now, because the files changed and the person or a tool brought it up to date. Nothing was changed. Read it again with get_manifest (and get_coverage for what is new and not sorted yet), then send "version": ${String(error.current)} with what still applies.`
			);
		case 'VersionNotFound':
			return textForAgent(
				`Report ${error.report} has no version ${String(error.seen)}: its newest is ${String(error.current)}. Send the version from the first line of the answer you read, such as get_manifest's. Nothing was changed.`
			);
		case 'RevisionChangedWhileSaving':
			return textForAgent(
				`Report ${error.report} was brought up to date while this change was being saved, so nothing was changed. Read get_manifest again and send the new version.`
			);
		case 'ReportNotFound':
			return textForAgent(
				`There is no report ${error.report}: it may have been deleted. Call list_reports to see the reports there are, or create_report to make one.`
			);
		case 'ReportClosed':
			return textForAgent(
				`Report ${error.report} is closed, so it cannot be changed: the person closed it, or its changes were committed or discarded. Call create_report for the source you mean, which starts a new report when its last one is closed.`
			);
		case 'SnapshotGone':
			return textForAgent(
				`The saved copy of report ${error.report}'s changes is gone from diff delver's data folder, so it cannot be read or changed. ${error.open ? 'Call create_report for its source again, which replaces it with a new report.' : 'Call create_report for the source you mean.'}`
			);
		case 'SectionsRefused':
			return textForAgent(
				`The sections were not changed; nothing in this call was applied:\n${error.problems
					.slice(0, 20)
					.map((p) => `- ${describeSectionProblem(p)}`)
					.join(
						'\n'
					)}${error.problems.length > 20 ? `\n- and ${String(error.problems.length - 20)} more problems.` : ''}`
			);
		case 'ReadingOrderRefused':
			return textForAgent(
				`The reading order was not changed; nothing in this call was applied:\n${error.problems
					.slice(0, 20)
					.map((p) => `- ${describeStepProblem(p)}`)
					.join(
						'\n'
					)}${error.problems.length > 20 ? `\n- and ${String(error.problems.length - 20)} more problems.` : ''}`
			);
		case 'ReadingOrderSectionUnknown':
			return textForAgent(
				error.known.length === 0
					? `There is no section ${JSON.stringify(error.section)}: this version has no sections yet. Make them with upsert_sections and put lines in them with assign, then order a section's lines.`
					: `There is no section ${JSON.stringify(error.section)}. The sections are: ${error.known.join(', ')}. Nothing was changed.`
			);
		case 'NotesRefused':
			return textForAgent(
				`No notes were added; nothing in this call was applied:\n${error.problems
					.slice(0, 20)
					.map((p) => `- ${describeNoteProblem(p)}`)
					.join(
						'\n'
					)}${error.problems.length > 20 ? `\n- and ${String(error.problems.length - 20)} more problems.` : ''}`
			);
		case 'RequestNotFound':
			return textForAgent(
				'There is no request with that id. Use the id wait_for_requests gave, such as "request": 3.'
			);
		case 'RequestCancelled':
			return textForAgent(
				'The person cancelled that request, so it takes no answer. Call wait_for_requests for the next one.'
			);
		case 'AnswerRefused':
			return textForAgent(
				`The answer was not saved; nothing in this call was applied:\n${error.problems
					.slice(0, 20)
					.map((p) => `- ${p}`)
					.join('\n')}`
			);
		case 'InvalidRequest':
		case 'RequestNotPromotable':
		case 'NoteNotFound':
		case 'AnotherReportOpen':
		case 'ReportHasNoRevision':
		case 'RepositoryReplaced':
		case 'DuplicateFilePath':
		case 'StoredStateMismatch':
		case 'PartNotFound':
		case 'PathNotFound':
		case 'PathIsDirectory':
		case 'PathIsSubmodule':
		case 'FileIsBinary':
		case 'NotAnImage':
		case 'ImageTooLarge':
		case 'InvalidCommentRange':
		case 'InvalidCommentBody':
		case 'CommentNotFound':
		case 'CommentChanged':
		case 'InvalidOverallReview':
		case 'OverallReviewChanged':
		case 'NothingToFinish':
		case 'DraftChanged':
		case 'CommentsFinished':
		case 'CommentFinished':
		case 'ReviewNotFound':
		case 'FileNotInDiff':
		case 'NothingToMark':
		case 'SortingChanged':
		case 'AssignmentsChanged':
		case 'MalformedRawListing':
		case 'MalformedPatch':
		case 'PatchCountMismatch':
		case 'PatchMismatch':
		case 'DatabaseUnusable':
		case 'NotADatabase':
		case 'DatabaseCorrupt':
		case 'DatabaseTooNew':
		case 'MigrationFailed':
		case 'DatabaseBusy':
		case 'StoredRowInvalid':
		case 'DatabaseFailed':
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
		case 'GitHubUnreachable':
		case 'GitHubTimedOut':
		case 'GitHubSignInNeeded':
		case 'GitHubSignInRefused':
		case 'GitHubNoAccess':
		case 'GitHubRateLimited':
		case 'PullRequestNotFound':
		case 'GitHubAnswerUnreadable':
		case 'PullRequestFetchFailed':
		case 'PullRequestNoMergeBase':
		case 'NotACloneOf':
		case 'NotOnGitHub':
		case 'ReviewNotPosted':
		case 'NotAPullRequest':
			return textForAgent(describeReportError(error));
	}
}
