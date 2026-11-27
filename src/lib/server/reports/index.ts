/**
 * The report service (DESIGN 5, 6, 7.1): opening a source as a report, reading a
 * report for display, the agent's sections and `assign`, the reviewer's marks,
 * closing, reopening and deleting, and noticing that a source changed. The
 * daemon makes one service for its data directory and calls it from every
 * route; the MCP tools will call the same methods.
 *
 * ```ts
 * const service = value(await ReportService.open({ dataDirectory, clock: systemClock, ids: randomIds }));
 * const started = await service.start(directory);           // the no-argument start
 * const opened = await service.open(directory, spec);       // or one source
 * const page = await service.load(reportId);                // diff, sections, state, marks, progress
 * const seen = page.revision.number;                        // changes are made on what was seen
 * await service.upsertSections(reportId, seen, [{ id: 'auth', title: 'Sign-in' }]);
 * await service.assign(reportId, seen, [{ file: 'src/auth.ts', section: 'auth' }]);
 * await service.markReviewed(reportId, seen, { kind: 'file', path }, true);
 * const updated = await service.update(reportId);          // the files as they are now
 * ```
 *
 * Every method returns a `Result`; `describeReportError` gives any error's
 * message for the reviewer.
 */
export type {
	ChangeCheck,
	DamagedReport,
	Deleted,
	LastUpdate,
	ListedReport,
	LoadedReport,
	MarkOutcome,
	NotesAdded,
	RequestAbout,
	OpenOutcome,
	PartColours,
	PartMatches,
	PartContent,
	PartImage,
	ImageSide,
	ImageFile,
	SideColours,
	ReportServiceOptions,
	RepositoryBranches,
	RepositoryPullRequests,
	ReportSummary,
	StartOutcome,
	StoredSnapshot,
	UpdateOutcome,
	ShownComment,
	ShownDraft,
	FinishOptions,
	JustFinished,
	ReviewPreview
} from './report-service.ts';
export {
	PULL_REQUEST_CHECK_EVERY_MS,
	PULL_REQUEST_CHECK_SIGNED_OUT_EVERY_MS,
	ReportService
} from './report-service.ts';
export type {
	AnotherReportOpen,
	RepositoryReplaced,
	ReportClosed,
	ReportError,
	ReportHasNoRevision,
	ReportNotFound,
	RevisionChangedWhileSaving,
	VersionOutOfDate,
	VersionNotFound,
	PartNotFound,
	SectionsRefused,
	SnapshotGone
} from './report-error.ts';
export { describeReportError } from './report-error.ts';
export type { ReviewTarget } from '#lib/core/review/mark-reviewed.ts';
export type { FileProgress, GroupProgress, Progress, Tally } from '#lib/core/review/progress.ts';
export { reviewProgress } from '#lib/core/review/progress.ts';
export type { SectionRequest } from '#lib/core/reports/section-requests.ts';
export type {
	ClosedReason,
	Report,
	ReportState,
	Revision,
	Section
} from '#lib/core/reports/report.ts';
export { describeClosedReason } from '#lib/core/reports/describe-report.ts';
export type { NextSource } from '#lib/core/reports/nothing-left.ts';
export { randomIds, systemClock } from '../system.ts';
