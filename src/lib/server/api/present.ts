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
	UpdateView
} from '#lib/api/schemas.ts';
import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import type { Progress } from '#lib/core/review/progress.ts';
import { describeUpdate, type UpdateSummary } from '#lib/core/update/update-summary.ts';
import {
	describeClosedReason,
	describeDiffSize,
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
import type { ShownLine } from '#lib/core/viewer/part-lines.ts';
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
import { formatGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
// Its errors' messages from their own module, so the app's build does not take in
// the report service, which runs in the daemon.
import { describeReportError } from '../reports/report-error.ts';
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

/** How a part's file holds its content. */
function contentOf(part: PartSummary): PartView['content'] {
	return part.file.file.content.kind;
}

export function partView(part: PartSummary): PartView {
	return {
		group: part.group,
		path: escapedRepoPath(part.file.file.path),
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
		parts: file.parts.map((p) => p.group)
	};
}

/** The sets a loaded report's parts are counted against. */
export function marksOf(loaded: LoadedReport): PartMarks {
	return { reviewed: loaded.reviewed, fresh: loaded.fresh, unmarked: loaded.unmarked };
}

export function pageView(loaded: LoadedReport, now: Timestamp, view: ViewKind): DiffPage {
	const update = loaded.update;
	const titles = new Map<string, SectionTitle>(loaded.sections.map((s) => [s.id, s.title]));
	const frame = frameOf(
		loaded.diff,
		loaded.state,
		marksOf(loaded),
		view,
		loaded.sections.map((s) => s.id)
	);
	return {
		now,
		summary: summaryView(loaded.summary),
		directory: loaded.report.repositoryPath,
		source: formatGitSourceSpec(loaded.report.source.spec),
		leftOut: [...loaded.leftOut],
		view,
		groups: frame.groups.map((group) => ({
			key: group.key,
			title:
				group.key.kind === 'section' || group.key.kind === 'tests'
					? (titles.get(group.key.section) ?? sectionTitleOf(group.key.section))
					: null,
			parts: group.parts.map(partView)
		})),
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
	const parts: PartView[] = [];
	const files: FileView[] = [];
	for (const path of paths) {
		const file = loaded.diff.byPath.get(path);
		if (file === undefined) continue;
		const own = fileParts(file, loaded.state, marksOf(loaded), view, sections);
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
		parts,
		files,
		groups: [...progress.groups.values()].map((g) => ({
			key: g.key,
			units: g.tally.units,
			reviewed: g.tally.reviewedUnits
		}))
	};
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
				home: line.home
			};
		case 'added':
			return {
				kind: 'added',
				new: line.line.new,
				text: line.line.text,
				noNewlineAtEnd: line.line.noNewlineAtEnd,
				home: line.home
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
						groups: [...block.groups],
						lines: block.lines.map(lineView)
					};
			}
		}),
		sizes:
			content.sizes === undefined
				? null
				: { old: content.sizes.old ?? null, new: content.sizes.new ?? null }
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
		case 'PartNotFound':
		case 'PathNotFound':
			return 404;
		case 'ReportClosed':
		case 'AnotherReportOpen':
		case 'RevisionChangedWhileSaving':
		case 'VersionOutOfDate':
		case 'VersionNotFound':
		case 'DatabaseBusy':
			return 409;
		case 'SectionsRefused':
		case 'FileNotInDiff':
		case 'NothingToMark':
		case 'PathIsDirectory':
		case 'PathIsSubmodule':
		case 'FileIsBinary':
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
