/**
 * The report service's results as the API sends them (`#lib/api/schemas.ts`),
 * and its errors as HTTP answers. The routes call these; nothing else turns a
 * service value into JSON.
 */
import type {
	ApiErrorBody,
	Candidate,
	ChangeCheckResponse,
	DiffPage,
	DiffSummary,
	ListedDiff,
	NextSourceOffer,
	OpenResponse,
	StartResponse,
	SuggestResponse,
	UpdateResponse,
	UpdateView
} from '#lib/api/schemas.ts';
import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { describeUpdate, type UpdateSummary } from '#lib/core/update/update-summary.ts';
import {
	describeClosedReason,
	describeDiffSize,
	describeUnitProgress,
	repositoryLabel
} from '#lib/core/reports/describe-report.ts';
import { listFiles } from '#lib/core/reports/file-list.ts';
import type { NextSource } from '#lib/core/reports/nothing-left.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { formatGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import {
	describeReportError,
	type ChangeCheck,
	type ListedReport,
	type LoadedReport,
	type OpenOutcome,
	type ReportError,
	type ReportSummary,
	type StartOutcome,
	type UpdateOutcome
} from '../reports/index.ts';
import type { SourceCandidate, SuggestedSource } from '../sources/git/index.ts';

export function summaryView(summary: ReportSummary): DiffSummary {
	return {
		id: summary.id,
		title: summary.title,
		repository: summary.repository,
		state:
			summary.state.kind === 'open'
				? { kind: 'open' }
				: { kind: 'closed', reason: describeClosedReason(summary.state.reason) },
		lastActivityAt: summary.lastActivityAt,
		size: {
			files: summary.size.files,
			added: summary.size.addedLines,
			removed: summary.size.deletedLines
		},
		sizeText: describeDiffSize(summary.size),
		progress: summary.progress,
		progressText: describeUnitProgress(summary.progress),
		leftOut: summary.leftOut,
		version: summary.revision
	};
}

/** What an update that made `version` did, with its words. */
export function updateView(version: RevisionNumber, summary: UpdateSummary): UpdateView {
	return { version, ...summary, text: describeUpdate(summary) };
}

export function listedView(listed: ListedReport): ListedDiff {
	switch (listed.kind) {
		case 'report':
			return { kind: 'diff', ...summaryView(listed) };
		case 'damaged':
			return { kind: 'damaged', id: listed.id ?? null, problem: listed.problem };
	}
}

function candidateView(candidate: SourceCandidate): Candidate {
	return { source: formatGitSourceSpec(candidate.spec), description: candidate.description };
}

function nextView(next: NextSource | undefined): NextSourceOffer | null {
	return next === undefined ? null : { source: formatGitSourceSpec(next.spec), offer: next.offer };
}

export function openView(
	outcome: OpenOutcome,
	candidates: readonly SourceCandidate[] = []
): OpenResponse {
	switch (outcome.kind) {
		case 'created':
			return { kind: 'opened', diff: summaryView(outcome.report), resumed: false, update: null };
		case 'resumed':
			return {
				kind: 'opened',
				diff: summaryView(outcome.report),
				resumed: true,
				update:
					outcome.update === undefined ? null : updateView(outcome.report.revision, outcome.update)
			};
		case 'nothing-to-review':
			return {
				kind: 'nothing',
				source: outcome.source,
				reason: outcome.reason,
				leftOut: [...outcome.leftOut],
				next: nextView(outcome.next),
				candidates: candidates.map(candidateView)
			};
	}
}

export function startView(outcome: StartOutcome): StartResponse {
	switch (outcome.kind) {
		case 'opened':
			return openView(outcome.opened, outcome.others);
		case 'choose':
			return {
				kind: 'choose',
				repository: outcome.repository,
				candidates: outcome.candidates.map(candidateView)
			};
		case 'nothing':
			return {
				kind: 'nothing',
				source: null,
				reason: outcome.reason,
				leftOut: [],
				next: null,
				candidates: outcome.candidates.map(candidateView)
			};
		case 'failed':
			return {
				kind: 'failed',
				source: formatGitSourceSpec(outcome.tried.spec),
				description: outcome.tried.description,
				problem: describeReportError(outcome.problem),
				candidates: outcome.others.map(candidateView)
			};
	}
}

export function suggestView(
	suggested: SuggestedSource,
	asked: SuggestResponse['asked'] = null
): SuggestResponse {
	const repo = suggested.repository;
	const repository = repositoryLabel(repo.workTree ?? repo.gitDir);
	const s = suggested.suggestion;
	switch (s.kind) {
		case 'one':
			return {
				repository,
				asked,
				suggestion: {
					kind: 'one',
					candidate: candidateView(s.candidate),
					others: s.others.map(candidateView)
				}
			};
		case 'choose':
			return {
				repository,
				asked,
				suggestion: { kind: 'choose', candidates: s.candidates.map(candidateView) }
			};
		case 'nothing':
			return {
				repository,
				asked,
				suggestion: {
					kind: 'nothing',
					reason: s.reason,
					candidates: s.candidates.map(candidateView)
				}
			};
	}
}

export function pageView(loaded: LoadedReport, now: Timestamp): DiffPage {
	const update = loaded.update;
	return {
		now,
		summary: summaryView(loaded.summary),
		directory: loaded.report.repositoryPath,
		source: formatGitSourceSpec(loaded.report.source.spec),
		leftOut: [...loaded.leftOut],
		groups: listFiles(loaded.diff, loaded.state, loaded.sections, loaded.fresh).map((group) => ({
			group:
				group.kind === 'section' ? { kind: 'section', title: group.title } : { kind: group.kind },
			files: group.files.map((file) => ({
				path: file.path,
				change: file.change,
				added: file.added,
				removed: file.removed,
				ignored: [...file.ignored],
				newChanges: file.newChanges
			}))
		})),
		sorted: loaded.sections.length > 0,
		update:
			update === undefined
				? null
				: { ...updateView(update.revision, update.summary), at: update.at }
	};
}

export function changeView(check: ChangeCheck): ChangeCheckResponse {
	switch (check.kind) {
		case 'unchanged':
			return { kind: 'unchanged' };
		case 'changed':
			return { kind: 'changed', files: check.files };
		case 'updated':
			return { kind: 'updated', version: check.revision };
		case 'nothing-left':
			return { kind: 'nothing-left', reason: check.reason, next: nextView(check.next) };
		case 'report-closed':
			return { kind: 'closed' };
	}
}

export function updateResponseView(outcome: UpdateOutcome): UpdateResponse {
	switch (outcome.kind) {
		case 'updated':
			return {
				kind: 'updated',
				diff: summaryView(outcome.report),
				update: updateView(outcome.report.revision, outcome.summary)
			};
		case 'unchanged':
			return { kind: 'unchanged', diff: summaryView(outcome.report) };
		case 'nothing-left':
			return { kind: 'nothing-left', reason: outcome.reason, next: nextView(outcome.next) };
	}
}

/** The HTTP status a service error is answered with. */
export function statusOf(error: ReportError): number {
	switch (error.kind) {
		case 'ReportNotFound':
		case 'StoreNotFound':
		case 'SnapshotNotFound':
		case 'SnapshotGone':
			return 404;
		case 'ReportClosed':
		case 'AnotherReportOpen':
		case 'RevisionChangedWhileSaving':
		case 'VersionOutOfDate':
		case 'DatabaseBusy':
			return 409;
		case 'SectionsRefused':
		case 'FileNotInDiff':
		case 'NothingToMark':
		case 'UnresolvedConflict':
		case 'NoWorkingTree':
		case 'UnknownRevision':
		case 'NoCommitsYet':
		case 'ShallowHistory':
		case 'NoCommonHistory':
		case 'PartialCloneMissing':
		case 'NoSuchDirectory':
		case 'NotARepository':
		case 'DubiousOwnership':
		case 'BadRevision':
		case 'RepositoryReplaced':
			return 422;
		case 'GitNotFound':
		case 'GitTooOld':
		case 'MissingObject':
		case 'GitFailed':
		case 'DataDirectoryUnusable':
		case 'StoreDamaged':
		case 'DatabaseUnusable':
		case 'NotADatabase':
		case 'DatabaseCorrupt':
		case 'DatabaseTooNew':
		case 'MigrationFailed':
		case 'StoredRowInvalid':
		case 'DatabaseFailed':
		case 'StoredStateMismatch':
		case 'DuplicateFilePath':
		case 'ReportHasNoRevision':
		case 'MalformedRawListing':
		case 'MalformedPatch':
		case 'PatchCountMismatch':
		case 'PatchMismatch':
			return 500;
	}
}

/** An error the API answers with, with its message. */
export function failure(status: number, kind: string, message: ReviewerMessage): Response {
	const body: ApiErrorBody = { error: { kind, message } };
	return Response.json(body, { status });
}

export function serviceFailure(error: ReportError): Response {
	return failure(statusOf(error), error.kind, describeReportError(error));
}

/** A request whose body or query did not hold what the API expects. */
export function badRequest(what: string): Response {
	return failure(
		400,
		'BadRequest',
		reviewerMessage(
			`diff delver could not read this request (${what}). Reload the page and try again.`
		)
	);
}
