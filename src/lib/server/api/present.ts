/**
 * The report service's results as the API sends them (`#lib/api/schemas.ts`),
 * and its errors as HTTP answers. The routes call these; nothing else turns a
 * service value into JSON.
 */
import { gitHubRepositoryText } from '#lib/core/github/github-repository.ts';
import {
	describeListedDetails,
	describeListedTitle,
	describePullRequestList
} from '#lib/core/github/listed-pull-request.ts';
import { describeEarlierNotes, type AgentNote } from '#lib/core/review/agent-note.ts';
import type { EarlierThread } from '#lib/core/review/threads.ts';
import {
	describeRequestAnchor,
	isOpenRequest,
	requestPrompt,
	type AgentRequest,
	type DelveAsked
} from '#lib/core/review/agent-request.ts';
import { agentPath } from '#lib/core/diff/agent-text.ts';
import type {
	AgentNoteView,
	EarlierThreadView,
	AgentRequestView,
	ApiErrorBody,
	Candidate,
	CommitsView,
	HistoryView,
	RemoteCheckView,
	PullRequestsView,
	RunSizeView,
	ChangeCheckResponse,
	DiffPage,
	DiffSummary,
	FileView,
	Marked,
	PartBlockView,
	ColoursView,
	SideColoursView,
	PartLines,
	PartView,
	ShownLineView,
	ListedDiff,
	NextSourceOffer,
	OpenResponse,
	StartResponse,
	SuggestResponse,
	UpdateResponse,
	UpdateView,
	DiffSizeView
} from '#lib/api/schemas.ts';
import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import type { Progress } from '#lib/core/review/progress.ts';
import { describeUpdate, type UpdateSummary } from '#lib/core/update/update-summary.ts';
import {
	describeBinaryFiles,
	describeDiffSize,
	type DiffSize
} from '#lib/core/reports/diff-size.ts';
import {
	describeClosedReason,
	describeUnitProgress,
	repositoryLabel
} from '#lib/core/reports/describe-report.ts';
import { describeFileChange } from '#lib/core/diff/file-unit.ts';
import type { ViewKind } from '#lib/core/diff/slices.ts';
import { lineCountOf } from '#lib/core/line-count.tiny.ts';
import { escapedRepoPath } from '#lib/core/path-bytes.ts';
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import type { SectionId } from '#lib/core/section-id.tiny.ts';
import { parseSectionTitle, type SectionTitle } from '#lib/core/section-title.tiny.ts';
import type { LineHome, ShownLine } from '#lib/core/viewer/part-lines.ts';
import { StepLookup } from '#lib/core/reports/reading-order.ts';
import { groupKeyId } from '#lib/core/group-key-id.tiny.ts';
import {
	fileParts,
	fileTally,
	frameOf,
	type FrameFile,
	type PartMarks,
	type PartSummary
} from '#lib/core/viewer/parts.ts';
import type { NextSource } from '#lib/core/reports/nothing-left.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { describePullRequestChange } from '#lib/core/github/pull-request.ts';
import { formatGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { formatSourceSpec } from '#lib/core/sources/source-spec.ts';
import { sourceSpecOf } from '#lib/core/reports/report.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
// Its errors' messages from their own module, so the app's build does not take in
// the report service, which runs in the daemon.
import { describeReportError } from '../reports/report-error.ts';
import type { ReviewPostProblem } from '../sources/github/index.ts';
import type {
	ChangeCheck,
	ListedReport,
	LoadedReport,
	OpenOutcome,
	PartColours,
	PartContent,
	SideColours,
	ReportError,
	ReportSummary,
	StartOutcome,
	UpdateOutcome
} from '../reports/index.ts';
import type {
	CommitPage,
	CommitSize,
	RemoteOutcome,
	SourceCandidate,
	SuggestedSource
} from '../sources/git/index.ts';
import type { RepositoryBranches, RepositoryPullRequests } from '../reports/index.ts';
import { describeRemoteCheckError } from '#lib/core/history/remote-check.ts';

/** A diff's size as the API gives it. */
export function diffSizeView(size: DiffSize): DiffSizeView {
	return {
		files: size.files,
		added: size.addedLines,
		removed: size.deletedLines,
		tests: size.testLines
	};
}

export function summaryView(summary: ReportSummary): DiffSummary {
	return {
		id: summary.id,
		title: summary.title,
		repository: summary.repository,
		directory: summary.repositoryPath,
		state:
			summary.state.kind === 'open'
				? { kind: 'open' }
				: { kind: 'closed', reason: describeClosedReason(summary.state.reason) },
		lastActivityAt: summary.lastActivityAt,
		size: diffSizeView(summary.size),
		sizeText: describeDiffSize(summary.size),
		binary: summary.binary ?? null,
		binaryText:
			(summary.binary === undefined ? undefined : describeBinaryFiles(summary.binary)) ?? null,
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

/** The choose page's view of a repository: its branches and when it last fetched. */
export function historyView(found: RepositoryBranches, now: Timestamp): HistoryView {
	const { branches } = found;
	return {
		now,
		repository: found.repository,
		main: branches.main ?? null,
		branches: branches.shown.map((b) => ({
			ref: b.ref,
			committedAt: b.committedAt ?? null,
			current: b.current,
			main: b.main,
			ahead: b.ahead ?? null
		})),
		matching: branches.matching,
		noCommits: found.noCommits,
		remotes: [...branches.remotes],
		gitHub:
			found.gitHub === undefined
				? null
				: {
						remote: found.gitHub.remote,
						repository: gitHubRepositoryText(found.gitHub.repository)
					},
		lastFetch:
			found.lastFetch.kind === 'no-remote'
				? { kind: 'no-remote' }
				: { ...found.lastFetch, remotes: [...found.lastFetch.remotes] }
	};
}

export function commitsView(page: CommitPage): CommitsView {
	return {
		commits: page.commits.map((c) => ({
			commit: c.commit,
			parent: c.parent,
			merge: c.merge,
			subject: c.subject,
			author: c.author,
			committedAt: c.committedAt ?? null,
			size: c.size ?? null,
			onMain: c.onMain
		})),
		next: page.next ?? null
	};
}

export function runSizeView(size: CommitSize | undefined): RunSizeView {
	return { size: size ?? null };
}

export function pullRequestsView(found: RepositoryPullRequests, now: Timestamp): PullRequestsView {
	const { repository, pulls } = found;
	return {
		repository: gitHubRepositoryText(repository),
		summary: describePullRequestList(
			pulls.pulls.length,
			pulls.more,
			gitHubRepositoryText(repository)
		),
		pulls: pulls.pulls.map((pull) => ({
			source: formatSourceSpec({
				kind: 'pull-request',
				pullRequest: { repository, number: pull.number }
			}),
			number: pull.number,
			title: describeListedTitle(pull),
			details: describeListedDetails(pull, now),
			draft: pull.draft
		})),
		more: pulls.more
	};
}

export function remoteCheckView(outcomes: readonly RemoteOutcome[]): RemoteCheckView {
	return {
		remotes: outcomes.map((outcome) =>
			outcome.kind === 'compared'
				? {
						kind: 'compared',
						remote: outcome.comparison.remote,
						changed: [...outcome.comparison.changed],
						added: [...outcome.comparison.added]
					}
				: {
						kind: 'failed',
						remote: outcome.error.remote,
						problem: describeRemoteCheckError(outcome.error)
					}
		)
	};
}

/** How a part's file holds its content. */
function contentOf(part: PartSummary): PartView['content'] {
	return part.file.file.content.kind;
}

export function partView(part: PartSummary): PartView {
	return {
		group: part.group,
		path: escapedRepoPath(part.file.file.path),
		step: part.step ?? null,
		steps: part.steps,
		note: part.note ?? null,
		change: part.change,
		added: part.added,
		removed: part.removed,
		fileUnit: part.fileUnit ?? null,
		modeChange: part.modeChange ?? null,
		ignored: [...part.ignored],
		tally: part.tally,
		rows: part.rows,
		position: part.position,
		of: part.of,
		others: [...part.others],
		content: contentOf(part)
	};
}

export function fileView(file: FrameFile): FileView {
	return {
		path: escapedRepoPath(file.file.file.path),
		change: file.change,
		added: file.added,
		removed: file.removed,
		tally: file.tally,
		ignored: file.ignored,
		// A file over several steps of a section is in that section once.
		parts: [...new Map(file.parts.map((p) => [groupKeyId(p.group), p.group])).values()]
	};
}

/** The sets a loaded report's parts are counted against. */
export function marksOf(loaded: LoadedReport): PartMarks {
	return { reviewed: loaded.reviewed, fresh: loaded.fresh, unmarked: loaded.unmarked };
}

/**
 * A diff's page as the API gives it. The threads of earlier reviews are the
 * reviewer's, so only a browser that may read reviews (`reviews`) gets them.
 */
export function pageView(
	loaded: LoadedReport,
	now: Timestamp,
	view: ViewKind,
	reviews = true
): DiffPage {
	const update = loaded.update;
	const sections = new Map(loaded.sections.map((section) => [section.id, section]));
	const frame = frameOf(
		loaded.diff,
		loaded.state,
		marksOf(loaded),
		view,
		loaded.sections.map((s) => s.id),
		new StepLookup(loaded.readingOrders)
	);
	return {
		now,
		asOf:
			loaded.asOf === undefined
				? null
				: { review: loaded.asOf.number, submittedAt: loaded.asOf.submittedAt },
		latestReview: reviews ? (loaded.latestReview ?? null) : null,
		summary: summaryView(loaded.summary),
		overview: loaded.overview ?? null,
		overviewRead: loaded.read.overview,
		notes: notesView(loaded.notes),
		earlierNotes:
			loaded.earlierNotes === undefined ? null : describeEarlierNotes(loaded.earlierNotes),
		requests: requestsView(loaded.requests, {
			id: loaded.report.id,
			title: loaded.summary.title,
			repository: loaded.summary.repository,
			version: loaded.summary.revision
		}),
		agentConnected: loaded.agentListening,
		threads: reviews ? threadsView(loaded.threads) : null,
		frame: `${framePrefix(view, reviews)}${loaded.frame}`,
		sorting: loaded.sorting,
		assignments: loaded.assignments,
		source: formatSourceSpec(sourceSpecOf(loaded.report.source)),
		leftOut: [...loaded.leftOut],
		view,
		groups: frame.groups.map(({ key, parts }) => {
			const sectionId = key.kind === 'section' || key.kind === 'tests' ? key.section : undefined;
			const section = sectionId === undefined ? undefined : sections.get(sectionId);
			return {
				key,
				title: sectionId === undefined ? null : (section?.title ?? sectionTitleOf(sectionId)),
				summary: section?.summary ?? null,
				summaryRead: sectionId !== undefined && loaded.read.sections.has(sectionId),
				parts: parts.map(partView)
			};
		}),
		files: frame.files.map(fileView),
		sorted: loaded.sections.length > 0,
		update:
			update === undefined
				? null
				: { ...updateView(update.revision, update.summary), at: update.at }
	};
}

/** A section the state uses but the list lacks is shown by its id, never dropped. */
function sectionTitleOf(section: SectionId): SectionTitle {
	const title = parseSectionTitle(section);
	if (!title.ok) throw new Error(`A section id is not a title: ${section}`);
	return title.value;
}

/** What marking changed, for the page: its summary, and the touched files' parts and files. */
export function markedView(
	loaded: LoadedReport,
	view: ViewKind,
	paths: Iterable<RepoPath>,
	progress: Progress
): Marked {
	const sections = loaded.sections.map((s) => s.id);
	const steps = new StepLookup(loaded.readingOrders);
	const parts: PartView[] = [];
	const files: FileView[] = [];
	for (const path of paths) {
		const file = loaded.diff.byPath.get(path);
		if (file === undefined) continue;
		const own = fileParts(file, loaded.state, marksOf(loaded), view, sections, steps);
		parts.push(...own.map(partView));
		const { tally, ignored } = fileTally(own);
		files.push(
			fileView({
				file,
				change: describeFileChange(file.file),
				added: lineCountOf(file.changed.new.size),
				removed: lineCountOf(file.changed.old.size),
				tally,
				ignored,
				parts: own
			})
		);
	}
	return {
		summary: summaryView(loaded.summary),
		sorting: loaded.sorting,
		parts,
		files,
		groups: [...progress.groups.values()].map((g) => ({
			key: g.key,
			units: g.tally.units,
			reviewed: g.tally.reviewedUnits
		}))
	};
}

function homeView(home: LineHome): Extract<ShownLineView, { kind: 'added' }>['home'] {
	return home.kind === 'here'
		? home
		: { kind: 'elsewhere', group: home.group, step: home.step ?? null };
}

function lineView(line: ShownLine): ShownLineView {
	switch (line.kind) {
		case 'context':
			return {
				kind: 'context',
				old: line.line.old,
				new: line.line.new,
				text: line.line.text,
				noNewlineAtEnd: line.line.noNewlineAtEnd
			};
		case 'deleted':
			return {
				kind: 'deleted',
				old: line.line.old,
				text: line.line.text,
				noNewlineAtEnd: line.line.noNewlineAtEnd,
				home: homeView(line.home)
			};
		case 'added':
			return {
				kind: 'added',
				new: line.line.new,
				text: line.line.text,
				noNewlineAtEnd: line.line.noNewlineAtEnd,
				home: homeView(line.home)
			};
	}
}

function sideColoursView(side: SideColours | undefined): SideColoursView {
	if (side === undefined) return null;
	switch (side.kind) {
		case 'plain':
			return side;
		case 'coloured':
			return {
				kind: 'coloured',
				lines: side.lines.map((l) => ({ number: l.number, runs: [...l.runs] }))
			};
	}
}

export function coloursView(colours: PartColours): ColoursView {
	return { old: sideColoursView(colours.old), new: sideColoursView(colours.new) };
}

export function partLinesView(content: PartContent): PartLines {
	return {
		blocks: content.blocks.map((block): PartBlockView => {
			switch (block.kind) {
				case 'hidden':
					return { kind: 'hidden', old: block.old, new: block.new };
				case 'hunk':
					return { kind: 'hunk', heading: block.heading, lines: block.lines.map(lineView) };
				case 'elsewhere':
					return {
						kind: 'elsewhere',
						places: block.places.map((p) => ({ group: p.group, step: p.step ?? null })),
						lines: block.lines.map(lineView)
					};
			}
		}),
		sizes:
			content.sizes === undefined
				? null
				: { old: content.sizes.old ?? null, new: content.sizes.new ?? null },
		image:
			content.image === undefined
				? null
				: {
						old: content.image.old ?? null,
						new: content.image.new ?? null,
						sameBytes: content.image.sameBytes,
						change: content.image.change ?? null
					}
	};
}

export function changeView(check: ChangeCheck): ChangeCheckResponse {
	switch (check.kind) {
		case 'unchanged':
			return { kind: 'unchanged' };
		case 'changed':
			return {
				kind: 'changed',
				files: check.files,
				reason:
					check.pullRequest === undefined
						? reviewerMessage('What you see here is how they were before.')
						: describePullRequestChange(check.pullRequest)
			};
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

/** The HTTP status a review that was not posted is answered with. */
function postStatusOf(problem: ReviewPostProblem): number {
	switch (problem.kind) {
		case 'rate-limited':
			return 429;
		case 'unreachable':
		case 'unreadable':
			return 502;
		case 'unanswered':
			return 504;
		case 'being-posted':
		case 'earlier-post-recent':
			return 409;
		case 'earlier-post-unchecked':
			return postStatusOf(problem.cause);
		case 'signed-out':
		case 'sign-in-refused':
		case 'not-allowed':
		case 'pending-review-exists':
		case 'own-pull-request':
		case 'refused':
		case 'lines-refused':
		case 'too-long':
		case 'moved-on':
		case 'closed':
		case 'no-commit':
			return 422;
	}
}

/** The HTTP status a service error is answered with. */
export function statusOf(error: ReportError): number {
	switch (error.kind) {
		case 'ReviewNotPosted':
			return postStatusOf(error.problem);
		case 'NotAPullRequest':
			return 422;
		case 'ReportNotFound':
		case 'StoreNotFound':
		case 'SnapshotNotFound':
		case 'SnapshotGone':
		case 'PartNotFound':
		case 'PathNotFound':
		case 'CommentNotFound':
		case 'NoteNotFound':
		case 'RequestNotFound':
		case 'ReviewNotFound':
		case 'PullRequestNotFound':
		case 'ThreadNotFound':
			return 404;
		case 'GitHubRateLimited':
			return 429;
		case 'GitHubUnreachable':
		case 'GitHubAnswerUnreadable':
		case 'PullRequestFetchFailed':
			return 502;
		case 'GitHubTimedOut':
			return 504;
		case 'ReportClosed':
		case 'AnotherReportOpen':
		case 'RevisionChangedWhileSaving':
		case 'CommentChanged':
		case 'RequestCancelled':
		case 'OverallReviewChanged':
		case 'DraftChanged':
		case 'CommentsFinished':
		case 'CommentFinished':
		case 'ThreadReplied':
		case 'VersionOutOfDate':
		case 'SortingChanged':
		case 'AssignmentsChanged':
		case 'VersionNotFound':
		case 'DatabaseBusy':
			return 409;
		case 'SectionsRefused':
		case 'ReadingOrderRefused':
		case 'ReadingOrderSectionUnknown':
		case 'NotesRefused':
		case 'InvalidRequest':
		case 'AnswerRefused':
		case 'RequestNotPromotable':
		case 'InvalidCommentRange':
		case 'InvalidCommentBody':
		case 'InvalidOverallReview':
		case 'NothingToFinish':
		case 'FileNotInDiff':
		case 'NothingToMark':
		case 'PathIsDirectory':
		case 'PathIsSubmodule':
		case 'FileIsBinary':
		case 'NotAnImage':
		case 'ImageTooLarge':
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
		case 'GitHubSignInNeeded':
		case 'GitHubSignInRefused':
		case 'GitHubNoAccess':
		case 'PullRequestNoMergeBase':
		case 'NotACloneOf':
		case 'NotOnGitHub':
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
	return failure(statusOf(error), reasonOf(error), describeReportError(error));
}

/**
 * The kind of error a page is told: the service's, but for a review not
 * posted because an earlier post of it could not be looked for on GitHub,
 * `EarlierPostUnchecked`, so the page can offer to finish and copy it anyway.
 */
function reasonOf(error: ReportError): string {
	return error.kind === 'ReviewNotPosted' && error.problem.kind === 'earlier-post-unchecked'
		? 'EarlierPostUnchecked'
		: error.kind;
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

/** The reviewer's questions for the agent as a page draws them: cancelled ones are gone. */
export function requestsView(
	requests: readonly AgentRequest[],
	delve: DelveAsked
): AgentRequestView[] {
	return requests
		.filter((request) => request.status !== 'cancelled')
		.map((request) => ({
			id: request.id,
			version: request.version,
			anchor:
				request.anchor.kind === 'section'
					? request.anchor
					: { ...request.anchor, path: escapedRepoPath(request.anchor.path) },
			about: reviewerMessage(describeRequestAnchor(request.anchor)),
			question: request.question,
			status: request.status,
			promoted: request.promoted,
			promotable: request.anchor.kind === 'lines' && request.answers.length > 0,
			prompt: isOpenRequest(request.status) ? requestPrompt(delve, request, agentPath) : null,
			answers: request.answers.map((answer) => ({
				body: answer.body,
				excerpts: answer.excerpts.map((excerpt) => ({
					path: escapedRepoPath(excerpt.path),
					side: excerpt.side,
					first: excerpt.first,
					last: excerpt.last,
					lines: [...excerpt.lines],
					more: Math.max(0, excerpt.last - excerpt.first + 1 - excerpt.lines.length)
				}))
			}))
		}));
}

/**
 * What a frame's stamp starts with: the view, and whether the browser may
 * read reviews, so a page that is let write its drafts gets the threads it
 * could not read before.
 */
export function framePrefix(view: ViewKind, reviews: boolean): string {
	return `${view}:${reviews ? 'review' : 'view'}:`;
}

/** The threads of earlier reviews as a page draws them. */
export function threadsView(threads: readonly EarlierThread[]): EarlierThreadView[] {
	return threads.map((t) => ({
		id: t.id,
		kind: t.kind,
		status: t.status,
		at: t.at === undefined ? null : { ...t.at, path: escapedRepoPath(t.at.path) },
		messages: t.messages.map((m) => ({
			review: m.review,
			kind: m.kind,
			version: m.version,
			anchor: { ...m.anchor, path: escapedRepoPath(m.anchor.path) },
			body: m.body,
			writtenAt: m.writtenAt
		})),
		quoted: [...t.quoted]
	}));
}

/** The agent's notes as a page draws them: promoted ones are comments of the draft by then. */
export function notesView(notes: readonly AgentNote[]): AgentNoteView[] {
	return notes
		.filter((note) => note.state !== 'promoted')
		.map((note) => ({
			id: note.id,
			label: note.label,
			anchor: { ...note.anchor, path: escapedRepoPath(note.anchor.path) },
			text: note.text,
			dismissed: note.state === 'dismissed'
		}));
}
