/**
 * The report service: every operation on reports that the daemon's HTTP routes
 * and, later, the MCP tools call (DESIGN 6, 7.1, 5). Import it from `index.ts`.
 *
 * What it keeps where:
 *
 * - The database holds reports, revisions, sections, assignments and reviewed
 *   marks. Every change is one transaction, so a failure leaves the database as
 *   it was.
 * - The store holds each revision's snapshot. The diff is read from it, never
 *   from the reviewed repository, so a report stays readable after the
 *   repository has moved on or gone. Only opening a source and checking it for
 *   changes look at the repository, and they never write to it.
 * - Diffs are cached in memory per snapshot, which never changes.
 *
 * A report is the same source followed over time (`report-identity.ts`). It is
 * open until the reviewer closes it, or its source is opened again with nothing
 * left to review; it never closes under the person reading it (DESIGN 6.1).
 * Opening an open report's source resumes it, and opening a source whose last
 * report is closed starts a new one.
 */
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import type { Clock } from '#lib/core/clock.ts';
import { assign, type AssignOutcome, type AssignRequest } from '#lib/core/diff/assign.ts';
import { autoIgnore, type AutoIgnored } from '#lib/core/diff/auto-ignore.ts';
import { makeDiff, type Diff } from '#lib/core/diff/diff.ts';
import type { ViewKind } from '#lib/core/diff/slices.ts';
import { initialState, type AssignmentState } from '#lib/core/diff/state.ts';
import type { IdSource } from '#lib/core/ids.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import type { ReportIdentity } from '#lib/core/report-identity.tiny.ts';
import {
	describeNothingToReview,
	diffSizeOf,
	reportTitle,
	repositoryLabel
} from '#lib/core/reports/describe-report.ts';
import {
	nothingLeft,
	type CommitsSince,
	type NextSource,
	type NothingLeft
} from '#lib/core/reports/nothing-left.ts';
import { gitReportIdentity } from '#lib/core/reports/report-identity.ts';
import type { Report, ReportState, Revision, Section } from '#lib/core/reports/report.ts';
import { applySectionRequests, type SectionRequest } from '#lib/core/reports/section-requests.ts';
import { markReviewed, type ReviewTarget } from '#lib/core/review/mark-reviewed.ts';
import { reviewProgress, unitProgressOf, type Progress } from '#lib/core/review/progress.ts';
import { NO_MARKS, type ReviewedMarks } from '#lib/core/review/reviewed-marks.ts';
import { andThen, err, ok, type Result } from '#lib/core/result.ts';
import { repositoryNameOf } from '#lib/core/repository-name.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { FIRST_REVISION } from '#lib/core/revision-number.tiny.ts';
import type { SnapshotId } from '#lib/core/snapshot-id.tiny.ts';
import type { SourceIdentity } from '#lib/core/source-identity.tiny.ts';
import { describeGitSource, type GitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import {
	assignmentRowsOf,
	assignmentStateFromRows,
	changedAssignmentPaths,
	reviewedMarksFromRows,
	reviewedRowsOf,
	type AssignmentRow,
	type ReviewedRow
} from '#lib/core/storage/stored-units.ts';
import type { StoreId } from '#lib/core/store-id.tiny.ts';
import { timeBetween } from '#lib/core/timestamp.tiny.ts';
import { fileCountOf, type FileCount } from '#lib/core/file-count.tiny.ts';
import { snapshotCountOf, type SnapshotCount } from '#lib/core/snapshot-count.tiny.ts';
import type { UnitCount } from '#lib/core/unit-count.tiny.ts';
import { Database, type DatabaseError, type Queries } from '../db/index.ts';
import { assignmentRowsFor, replaceAssignmentRows } from '../db/tables/assignments.ts';
import {
	deleteReportRow,
	everyReport,
	insertReport,
	openReportFor,
	reportById,
	reportExists,
	setReportState,
	touchReport
} from '../db/tables/reports.ts';
import { replaceReviewedRows, reviewedRowsFor } from '../db/tables/reviewed-marks.ts';
import {
	currentRevision,
	currentRevisions,
	insertRevision,
	setRevisionProgress,
	snapshotInUse,
	snapshotsInUse,
	snapshotsOfReport
} from '../db/tables/revisions.ts';
import { replaceSections, sectionsOf } from '../db/tables/sections.ts';
import {
	forgetSnapshot,
	noticeSnapshot,
	sightingsIn
} from '../db/tables/unreferenced-snapshots.ts';
import {
	commitsSince,
	locateRepository,
	snapshotGitSource,
	sourceIdentity,
	suggestSource,
	type LocalRepository,
	type RepositoryOptions,
	type SourceCandidate
} from '../sources/git/index.ts';
import {
	collectGarbage,
	deleteSnapshot,
	describeStoreError,
	generatedPaths,
	GRACE_PERIOD,
	listSnapshots,
	listStores,
	openSnapshotRef,
	openStore,
	readSnapshotDiff,
	type Snapshot,
	type StoreError
} from '../store/index.ts';
import { describeReportError, type ReportError } from './report-error.ts';

export interface ReportServiceOptions {
	/** Where the database and the stores live. */
	readonly dataDirectory: AbsolutePath;
	/** Where every timestamp comes from. */
	readonly clock: Clock;
	/** Where every report, revision and snapshot id comes from. */
	readonly ids: IdSource;
	/** How git runs in reviewed repositories; tests give their own reviewer config. */
	readonly repository?: RepositoryOptions;
}

/** A report as a list or a page header shows it. */
export interface ReportSummary {
	readonly id: ReportId;
	/** The source in plain words: "Uncommitted changes", "feature compared with main". */
	readonly title: ReviewerMessage;
	/** The repository's folder name: "diff-delver". */
	readonly repository: ReviewerMessage;
	readonly state: ReportState;
	readonly createdAt: Report['createdAt'];
	readonly lastActivityAt: Report['lastActivityAt'];
	/** The current revision's number, size and progress. */
	readonly revision: Revision['number'];
	readonly size: Revision['size'];
	readonly progress: Revision['progress'];
	/** How many files could not be included; the report page lists them. */
	readonly leftOut: FileCount;
}

/**
 * A report in the list. One whose saved rows cannot be read is listed as
 * damaged, beside the others, so the reviewer can see it and delete it.
 */
export type ListedReport = ({ readonly kind: 'report' } & ReportSummary) | DamagedReport;

/** A report whose saved rows cannot be read. `deleteReport` removes it. */
export interface DamagedReport {
	readonly kind: 'damaged';
	/** Undefined only when the id itself cannot be read; such a row cannot be deleted from here. */
	readonly id: ReportId | undefined;
	/** What is wrong and what to do, for the reviewer. */
	readonly problem: ReviewerMessage;
}

/** What opening a source did. */
export type OpenOutcome =
	/** A new report, with revision 1 of the source. */
	| {
			readonly kind: 'created';
			readonly report: ReportSummary;
			/** What the built-in rules and `linguist-generated` put in Ignored. */
			readonly autoIgnored: readonly AutoIgnored[];
			/**
			 * The source's open report this one replaces, closed because its saved
			 * snapshot was gone, so it could not be shown.
			 */
			readonly closed: ReportId | undefined;
	  }
	/** The source's open report. `changed` says the source has moved on since its revision. */
	| { readonly kind: 'resumed'; readonly report: ReportSummary; readonly changed: boolean }
	/** The source has nothing to review, so there is no report to show. */
	| {
			readonly kind: 'nothing-to-review';
			/** The source in plain words. */
			readonly source: ReviewerMessage;
			/** Why there is nothing, and what to do instead. */
			readonly reason: ReviewerMessage;
			/** Files that could not be included, which may be why it looks empty. */
			readonly leftOut: readonly ReviewerMessage[];
			/**
			 * The source's open report this closed: because the source has nothing
			 * left to review, or because its saved snapshot was gone.
			 */
			readonly closed: ReportId | undefined;
			/**
			 * Where the closed report's changes most likely went, such as the commit
			 * they were committed in, to offer instead; undefined when it cannot be told.
			 */
			readonly next: NextSource | undefined;
	  };

/** What the no-argument start did (DESIGN 3): opened the likely source, or needs a choice. */
export type StartOutcome =
	| {
			readonly kind: 'opened';
			readonly opened: OpenOutcome;
			/** Other sources worth offering beside it. */
			readonly others: readonly SourceCandidate[];
	  }
	| { readonly kind: 'choose'; readonly candidates: readonly SourceCandidate[] }
	| {
			readonly kind: 'nothing';
			readonly reason: ReviewerMessage;
			readonly candidates: readonly SourceCandidate[];
	  };

/** Everything a report page needs, read from the database and the store only. */
export interface LoadedReport {
	readonly summary: ReportSummary;
	readonly report: Report;
	readonly revision: Revision;
	/** The revision's snapshot, to read any file of either side (`readSnapshotFile`). */
	readonly snapshot: Snapshot;
	readonly diff: Diff;
	/** In reading order. */
	readonly sections: readonly Section[];
	readonly state: AssignmentState;
	readonly reviewed: ReviewedMarks;
	/**
	 * Progress in the sections view, its groups in reading order;
	 * `reviewProgress` gives it for the other view.
	 */
	readonly progress: Progress;
	/** Files that could not be included, one sentence each. */
	readonly leftOut: readonly ReviewerMessage[];
}

/** What marking did. */
export interface MarkOutcome {
	readonly reviewed: ReviewedMarks;
	readonly progress: Progress;
	/** How many units the target covers. */
	readonly units: UnitCount;
}

/** Whether an open report's source has moved on since its current revision. */
type SourceCheck =
	/** Nothing changed, or the fingerprint raised a false alarm. */
	| { readonly kind: 'unchanged' }
	/** The trees differ: an update is waiting. */
	| { readonly kind: 'changed' }
	/**
	 * The source has nothing left to review (DESIGN 6.1). The report stays open
	 * and readable: the page says so, keeps showing what was being read, and
	 * offers to close it or to open `next`.
	 */
	| ({ readonly kind: 'nothing-left' } & NothingLeft);

/** Whether a report's source has moved on since its current revision (DESIGN 6.2, 6.1). */
export type ChangeCheck =
	| SourceCheck
	/** The report is closed; closed reports are not followed. */
	| { readonly kind: 'report-closed' };

/** What deleting a report did. */
export interface Deleted {
	/** The snapshots removed from the store. */
	readonly snapshots: SnapshotCount;
	/**
	 * Set when the rows went but the snapshots could not be removed; they are
	 * removed later by `removeUnusedSnapshots`.
	 */
	readonly storeProblem: ReviewerMessage | undefined;
}

/** A snapshot in a store. */
export interface StoredSnapshot {
	readonly store: StoreId;
	readonly snapshot: SnapshotId;
}

/** How many diffs to keep in memory: the reports a reviewer has open at once. */
const CACHED_DIFFS = 8;

/** How many times a write is tried again when a new revision appeared while its diff was read. */
const RETRIES = 3;

interface Current {
	readonly report: Report;
	readonly revision: Revision;
}

/** A revision's stored rows, before they are checked against its diff. */
interface Stored {
	readonly sections: readonly Section[];
	readonly rows: readonly AssignmentRow[];
	readonly marked: readonly ReviewedRow[];
}

interface Remembered {
	readonly revision: Revision['id'];
	readonly fingerprint: SourceIdentity;
	readonly outcome: SourceCheck;
}

/** What a delete says when its rows went but its snapshots could not be removed yet. */
function notFreed(error: StoreError): ReviewerMessage {
	return reviewerMessage(
		`The report was deleted, but the space its saved changes use could not be freed yet; diff delver frees it by itself later. What went wrong: ${describeStoreError(error)}`
	);
}

function worktreeOf(repo: LocalRepository): AbsolutePath {
	return repo.workTree ?? repo.gitDir;
}

function summaryOf(report: Report, revision: Revision): ReportSummary {
	return {
		id: report.id,
		title: reportTitle(report.source),
		repository: repositoryLabel(report.repositoryPath),
		state: report.state,
		createdAt: report.createdAt,
		lastActivityAt: report.lastActivityAt,
		revision: revision.number,
		size: revision.size,
		progress: revision.progress,
		leftOut: fileCountOf(revision.leftOut.length)
	};
}

/** The report and its current revision, or why there are none. */
function current(q: Queries, id: ReportId): Result<Current, ReportError> {
	return andThen(reportById(q, id), (report): Result<Current, ReportError> => {
		if (report === undefined) return err({ kind: 'ReportNotFound', report: id });
		return andThen(currentRevision(q, id), (revision) =>
			revision === undefined
				? err({ kind: 'ReportHasNoRevision', report: id })
				: ok({ report, revision })
		);
	});
}

/** Like `current`, for a change: the report must be open. */
function currentOpen(q: Queries, id: ReportId): Result<Current, ReportError> {
	return andThen(current(q, id), (found) =>
		found.report.state.kind === 'open' ? ok(found) : err({ kind: 'ReportClosed', report: id })
	);
}

/** The assignment state and reviewed marks of a revision, checked against its diff. */
function stateOf(
	q: Queries,
	revision: Revision,
	diff: Diff
): Result<{ state: AssignmentState; marks: ReviewedMarks }, ReportError> {
	return andThen(assignmentRowsFor(q, revision.id), (rows) =>
		andThen(assignmentStateFromRows(diff, rows), (state) =>
			andThen(reviewedRowsFor(q, revision.id), (marked) =>
				andThen(reviewedMarksFromRows(diff, marked), (marks) => ok({ state, marks }))
			)
		)
	);
}

export class ReportService {
	readonly #db: Database;
	readonly #dataDirectory: AbsolutePath;
	readonly #clock: Clock;
	readonly #ids: IdSource;
	readonly #repository: RepositoryOptions;
	readonly #diffs = new Map<string, Promise<Result<Diff, ReportError>>>();
	readonly #checks = new Map<ReportId, Remembered>();

	private constructor(db: Database, options: ReportServiceOptions) {
		this.#db = db;
		this.#dataDirectory = options.dataDirectory;
		this.#clock = options.clock;
		this.#ids = options.ids;
		this.#repository = options.repository ?? {};
	}

	/** Opens the service on a data directory, making its database if there is none. */
	static async open(options: ReportServiceOptions): Promise<Result<ReportService, DatabaseError>> {
		const db = await Database.open(options.dataDirectory, options.clock);
		return db.ok ? ok(new ReportService(db.value, options)) : db;
	}

	/** Closes the database. The service cannot be used afterwards. */
	close(): void {
		this.#db.close();
	}

	/**
	 * The no-argument start (DESIGN 3): opens what a person most plausibly wants
	 * to review in `directory`, or says what to choose between, or why there is
	 * nothing.
	 */
	async start(directory: AbsolutePath): Promise<Result<StartOutcome, ReportError>> {
		const suggested = await suggestSource(directory, this.#repository);
		if (!suggested.ok) return suggested;
		const { repository, suggestion } = suggested.value;
		switch (suggestion.kind) {
			case 'one': {
				const opened = await this.#openIn(repository, suggestion.candidate.spec);
				return opened.ok
					? ok({ kind: 'opened', opened: opened.value, others: suggestion.others })
					: opened;
			}
			case 'choose':
				return ok({ kind: 'choose', candidates: suggestion.candidates });
			case 'nothing':
				return ok({
					kind: 'nothing',
					reason: suggestion.reason,
					candidates: suggestion.candidates
				});
		}
	}

	/**
	 * Opens a source in the repository at `directory`: resumes its open report,
	 * or takes a snapshot and makes a new report with revision 1, everything
	 * uncategorised except what the built-in rules ignore.
	 */
	async open(
		directory: AbsolutePath,
		spec: GitSourceSpec
	): Promise<Result<OpenOutcome, ReportError>> {
		const repo = await locateRepository(directory, this.#repository);
		return repo.ok ? this.#openIn(repo.value, spec) : repo;
	}

	/** Everything a report page shows, from the database and the store; the repository is not touched. */
	async load(id: ReportId): Promise<Result<LoadedReport, ReportError>> {
		const found = this.#db.read((q) =>
			andThen(current(q, id), (c): Result<Current & Stored, ReportError> =>
				andThen(sectionsOf(q, c.revision.id), (sections) =>
					andThen(assignmentRowsFor(q, c.revision.id), (rows) =>
						andThen(reviewedRowsFor(q, c.revision.id), (marked) =>
							ok({ ...c, sections, rows, marked })
						)
					)
				)
			)
		);
		if (!found.ok) return found;
		const { report, revision, sections, rows, marked } = found.value;
		const snapshot = await this.#snapshotOf(report, revision);
		if (!snapshot.ok) return snapshot;
		const diff = await this.#diffOf(snapshot.value);
		if (!diff.ok) return diff;
		const state = assignmentStateFromRows(diff.value, rows);
		if (!state.ok) return state;
		const reviewed = reviewedMarksFromRows(diff.value, marked);
		if (!reviewed.ok) return reviewed;
		return ok({
			summary: summaryOf(report, revision),
			report,
			revision,
			snapshot: snapshot.value,
			diff: diff.value,
			sections,
			state: state.value,
			reviewed: reviewed.value,
			progress: reviewProgress(
				diff.value,
				state.value,
				reviewed.value,
				'sections',
				sections.map((s) => s.id)
			),
			leftOut: revision.leftOut
		});
	}

	/**
	 * Every report, open and closed, most recently active first. A report whose
	 * rows cannot be read is listed as damaged in its place, so one bad row
	 * never hides the others.
	 */
	list(): Result<readonly ListedReport[], ReportError> {
		return this.#db.read((q): Result<readonly ListedReport[], ReportError> => {
			const revisions = currentRevisions(q);
			return ok(
				everyReport(q).map((row): ListedReport => {
					if (!row.ok) {
						return {
							kind: 'damaged',
							id: row.error.id,
							problem: describeReportError(row.error.error)
						};
					}
					const report = row.value;
					const revision = revisions.get(report.id);
					if (revision === undefined) {
						return {
							kind: 'damaged',
							id: report.id,
							problem: describeReportError({ kind: 'ReportHasNoRevision', report: report.id })
						};
					}
					if (!revision.ok) {
						return { kind: 'damaged', id: report.id, problem: describeReportError(revision.error) };
					}
					return { kind: 'report', ...summaryOf(report, revision.value) };
				})
			);
		});
	}

	/**
	 * The agent's `upsert_sections`: creates, retitles, summarises and reorders
	 * the sections of the current revision, all or nothing. Returns them in
	 * reading order.
	 */
	upsertSections(
		id: ReportId,
		requests: readonly SectionRequest[],
		order?: readonly string[]
	): Result<readonly Section[], ReportError> {
		return this.#db.write((q) =>
			andThen(currentOpen(q, id), ({ revision }) =>
				andThen(sectionsOf(q, revision.id), (existing): Result<readonly Section[], ReportError> => {
					const next = applySectionRequests(existing, requests, order);
					if (!next.ok) return err({ kind: 'SectionsRefused', problems: next.error });
					replaceSections(q, revision.id, next.value);
					touchReport(q, id, this.#clock.now());
					return ok(next.value);
				})
			)
		);
	}

	/**
	 * The agent's `assign` (DESIGN 7.1) on the current revision: applies the
	 * items with core's rules, stores the result in one transaction, and returns
	 * core's outcome. Sections must exist (`upsertSections`) before lines go in them.
	 */
	async assign(
		id: ReportId,
		requests: readonly AssignRequest[]
	): Promise<Result<AssignOutcome, ReportError>> {
		return this.#changeState(id, (q, revision, diff, state, marks) =>
			andThen(sectionsOf(q, revision.id), (sections) => {
				const outcome = assign(diff, state, requests, {
					knownSections: new Set(sections.map((s) => s.id))
				});
				const changed = changedAssignmentPaths(diff, state, outcome.state);
				replaceAssignmentRows(
					q,
					revision.id,
					changed,
					assignmentRowsOf(diff, outcome.state, changed)
				);
				return ok({ result: outcome, state: outcome.state, marks });
			})
		);
	}

	/**
	 * Marks a slice, a file or a group of the current revision as reviewed, or
	 * not (DESIGN 5), in one transaction. Groups and slices are those of `view`.
	 */
	async markReviewed(
		id: ReportId,
		target: ReviewTarget,
		reviewed: boolean,
		view: ViewKind = 'sections'
	): Promise<Result<MarkOutcome, ReportError>> {
		return this.#changeState(id, (q, revision, diff, state, marks) =>
			andThen(markReviewed(diff, state, marks, target, reviewed, view), (marked) =>
				andThen(sectionsOf(q, revision.id), (sections) => {
					replaceReviewedRows(
						q,
						revision.id,
						marked.files,
						reviewedRowsOf(marked.marks, marked.files)
					);
					return ok({
						result: {
							reviewed: marked.marks,
							progress: reviewProgress(
								diff,
								state,
								marked.marks,
								view,
								sections.map((s) => s.id)
							),
							units: marked.units
						},
						state,
						marks: marked.marks
					});
				})
			)
		);
	}

	/** Closes a report at the reviewer's request. Closing a closed report changes nothing. */
	closeReport(id: ReportId): Result<ReportSummary, ReportError> {
		return this.#db.write((q) =>
			andThen(current(q, id), ({ report, revision }) => {
				if (report.state.kind === 'closed') return ok(summaryOf(report, revision));
				const state: ReportState = { kind: 'closed', reason: 'reviewer' };
				const now = this.#clock.now();
				setReportState(q, id, state, now);
				return ok(summaryOf({ ...report, state, lastActivityAt: now }, revision));
			})
		);
	}

	/** Reopens a closed report, unless another report of its source is open. */
	reopenReport(id: ReportId): Result<ReportSummary, ReportError> {
		return this.#db.write((q) =>
			andThen(current(q, id), ({ report, revision }) => {
				if (report.state.kind === 'open') return ok(summaryOf(report, revision));
				return andThen(
					openReportFor(q, report.identity),
					(other): Result<ReportSummary, ReportError> => {
						if (other !== undefined)
							return err({ kind: 'AnotherReportOpen', report: id, open: other.id });
						const state: ReportState = { kind: 'open' };
						const now = this.#clock.now();
						setReportState(q, id, state, now);
						return ok(summaryOf({ ...report, state, lastActivityAt: now }, revision));
					}
				);
			})
		);
	}

	/**
	 * Deletes a report: its rows, then its snapshots from the store, then lets
	 * the store collect what nothing else uses (DESIGN 3.2). A damaged report
	 * can be deleted too; it needs only its id to be readable.
	 */
	async deleteReport(id: ReportId): Promise<Result<Deleted, ReportError>> {
		const removed = this.#db.write((q): Result<readonly StoredSnapshot[], ReportError> => {
			if (!reportExists(q, id)) return err({ kind: 'ReportNotFound', report: id });
			const snapshots = snapshotsOfReport(q, id);
			deleteReportRow(q, id);
			return ok(snapshots.filter((s) => !snapshotInUse(q, s)));
		});
		if (!removed.ok) return removed;
		this.#checks.delete(id);
		const removedSnapshots = await this.#removeSnapshots(removed.value);
		return ok(removedSnapshots);
	}

	/**
	 * Whether the report's source has moved on since its current revision
	 * (DESIGN 6.2). The fingerprint is checked first; only when it differs is a
	 * snapshot taken, and its trees compared, before saying yes. A source with
	 * nothing left to review is reported with where its changes most likely
	 * went; the report is not closed, so it never closes under its reader
	 * (DESIGN 6.1). The repository is only read.
	 */
	async checkForChanges(id: ReportId): Promise<Result<ChangeCheck, ReportError>> {
		const found = this.#db.read((q) => current(q, id));
		if (!found.ok) return found;
		const { report } = found.value;
		if (report.state.kind === 'closed') return ok({ kind: 'report-closed' });
		const repo = await locateRepository(report.repositoryPath, this.#repository);
		if (!repo.ok) return repo;
		if (repo.value.storeId !== report.store) {
			return err({ kind: 'RepositoryReplaced', path: report.repositoryPath });
		}
		return this.#check(found.value, repo.value);
	}

	/**
	 * Removes snapshots no revision refers to that have gone unreferenced for
	 * longer than the store's grace period, such as one a crash left between
	 * taking a snapshot and recording its revision, then collects the store.
	 * The daemon calls this now and then; it returns what it removed.
	 */
	async removeUnusedSnapshots(): Promise<Result<readonly StoredSnapshot[], ReportError>> {
		const stores = await listStores(this.#dataDirectory);
		if (!stores.ok) return stores;
		const removed: StoredSnapshot[] = [];
		for (const store of stores.value) {
			const listed = await listSnapshots(store);
			if (!listed.ok) return listed;
			const now = this.#clock.now();
			const due = this.#db.write((q) =>
				andThen(snapshotsInUse(q), (inUse): Result<readonly SnapshotId[], ReportError> => {
					const used = new Set(inUse.filter((s) => s.store === store.id).map((s) => s.snapshot));
					const present = new Set(listed.value.map((s) => s.id));
					for (const id of present) if (!used.has(id)) noticeSnapshot(q, store.id, id, now);
					return andThen(sightingsIn(q, store.id), (sightings) => {
						const old: SnapshotId[] = [];
						for (const sighting of sightings) {
							if (!present.has(sighting.snapshot) || used.has(sighting.snapshot)) {
								forgetSnapshot(q, store.id, sighting.snapshot);
							} else if (timeBetween(sighting.firstSeenAt, now) > GRACE_PERIOD) {
								old.push(sighting.snapshot);
							}
						}
						return ok(old);
					});
				})
			);
			if (!due.ok) return due;
			for (const snapshot of due.value) {
				const deleted = await deleteSnapshot(store, snapshot);
				if (!deleted.ok && deleted.error.kind !== 'SnapshotNotFound') return deleted;
				const forgotten = this.#db.write((q) => {
					forgetSnapshot(q, store.id, snapshot);
					return ok(undefined);
				});
				if (!forgotten.ok) return forgotten;
				removed.push({ store: store.id, snapshot });
			}
			if (due.value.length > 0) {
				const collected = await collectGarbage(store);
				if (!collected.ok) return collected;
			}
		}
		return ok(removed);
	}

	// --- Inside -------------------------------------------------------------------

	async #openIn(
		repo: LocalRepository,
		spec: GitSourceSpec
	): Promise<Result<OpenOutcome, ReportError>> {
		const identity = gitReportIdentity({ store: repo.storeId, spec, worktree: worktreeOf(repo) });
		const existing = this.#db.read((q) =>
			andThen(openReportFor(q, identity), (report) =>
				report === undefined ? ok(undefined) : current(q, report.id)
			)
		);
		if (!existing.ok) return existing;
		if (existing.value === undefined) return this.#create(repo, spec, identity, undefined);
		const { report, revision } = existing.value;
		const readable = await this.#snapshotOf(report, revision);
		if (readable.ok) return this.#resume(existing.value, repo);
		if (readable.error.kind !== 'SnapshotGone') return readable;
		// Its snapshot is gone, so it can never be shown: close it and start again.
		const closed = this.#db.write((q) => {
			setReportState(q, report.id, { kind: 'closed', reason: 'snapshot-gone' }, this.#clock.now());
			return ok(undefined);
		});
		if (!closed.ok) return closed;
		this.#checks.delete(report.id);
		return this.#create(repo, spec, identity, report.id);
	}

	/** The revision's snapshot, or `SnapshotGone` when its store or snapshot is no longer there. */
	async #snapshotOf(report: Report, revision: Revision): Promise<Result<Snapshot, ReportError>> {
		const snapshot = await openSnapshotRef(this.#dataDirectory, {
			store: revision.store,
			snapshot: revision.snapshot
		});
		if (snapshot.ok) return snapshot;
		const missing =
			snapshot.error.kind === 'StoreNotFound' || snapshot.error.kind === 'SnapshotNotFound';
		if (!missing) return snapshot;
		return err({
			kind: 'SnapshotGone',
			report: report.id,
			source: reportTitle(report.source),
			open: report.state.kind === 'open'
		});
	}

	/**
	 * Resumes the source's open report; when its source has nothing left to
	 * review, closes it instead (DESIGN 6.1: it closes when its source is next
	 * opened and has nothing to review) and says so.
	 */
	async #resume(found: Current, repo: LocalRepository): Promise<Result<OpenOutcome, ReportError>> {
		const check = await this.#check(found, repo);
		if (!check.ok) return check;
		const resumed = (changed: boolean): Result<OpenOutcome, ReportError> =>
			andThen(
				this.#db.read((q) => current(q, found.report.id)),
				(now) => ok({ kind: 'resumed', report: summaryOf(now.report, now.revision), changed })
			);
		switch (check.value.kind) {
			case 'unchanged':
				return resumed(false);
			case 'changed':
				return resumed(true);
			case 'nothing-left': {
				const { next } = check.value;
				const closed = this.#db.write((q) =>
					andThen(reportById(q, found.report.id), (report): Result<void, ReportError> => {
						if (report?.state.kind === 'open') {
							setReportState(
								q,
								found.report.id,
								{ kind: 'closed', reason: 'source-empty' },
								this.#clock.now()
							);
						}
						return ok(undefined);
					})
				);
				if (!closed.ok) return closed;
				this.#checks.delete(found.report.id);
				return ok({
					kind: 'nothing-to-review',
					source: reportTitle(found.report.source),
					reason: describeNothingToReview(found.report.source.spec),
					leftOut: [],
					closed: found.report.id,
					next
				});
			}
		}
	}

	/** A new report of the source; `replacing` is the open report just closed for it, if any. */
	async #create(
		repo: LocalRepository,
		spec: GitSourceSpec,
		identity: ReportIdentity,
		replacing: ReportId | undefined
	): Promise<Result<OpenOutcome, ReportError>> {
		const taken = await snapshotGitSource(this.#dataDirectory, repo, spec, this.#ids.snapshotId());
		if (!taken.ok) return taken;
		const { snapshot } = taken.value;
		const discard = async <T>(result: Result<T, ReportError>): Promise<Result<T, ReportError>> => {
			await deleteSnapshot(snapshot.store, snapshot.id);
			return result;
		};
		const diff = await this.#diffOf(snapshot);
		if (!diff.ok) return discard(diff);
		if (diff.value.files.length === 0) {
			return discard(
				ok({
					kind: 'nothing-to-review',
					source: describeGitSource(spec),
					reason: describeNothingToReview(spec),
					leftOut: taken.value.leftOut,
					closed: replacing,
					next: undefined
				})
			);
		}
		const generated = await generatedPaths(
			snapshot,
			diff.value.files.map((f) => f.file.path)
		);
		if (!generated.ok) return discard(generated);
		const sorted = autoIgnore(diff.value, initialState(diff.value), {
			markedGenerated: generated.value
		});
		const now = this.#clock.now();
		const report: Report = {
			id: this.#ids.reportId(),
			identity,
			source: { kind: 'git', spec },
			store: repo.storeId,
			repositoryName: repositoryNameOf(repo.commonDir),
			repositoryPath: worktreeOf(repo),
			state: { kind: 'open' },
			createdAt: now,
			lastActivityAt: now
		};
		const revision: Revision = {
			id: this.#ids.revisionId(),
			report: report.id,
			number: FIRST_REVISION,
			store: snapshot.store.id,
			snapshot: snapshot.id,
			baseTree: snapshot.base,
			headTree: snapshot.head,
			fingerprint: taken.value.identity,
			baseCommit: taken.value.baseCommit,
			headCommit: taken.value.headCommit,
			leftOut: taken.value.leftOut,
			takenAt: now,
			size: diffSizeOf(diff.value),
			progress: unitProgressOf(reviewProgress(diff.value, sorted.state, NO_MARKS, 'sections'))
		};
		const written = this.#db.write((q) =>
			andThen(openReportFor(q, identity), (raced): Result<ReportId | undefined, ReportError> => {
				// Another copy of diff delver opened the same source first: use its report.
				if (raced !== undefined) return ok(raced.id);
				insertReport(q, report);
				insertRevision(q, revision);
				replaceAssignmentRows(q, revision.id, 'all', assignmentRowsOf(diff.value, sorted.state));
				return ok(undefined);
			})
		);
		if (!written.ok) return discard(written);
		if (written.value !== undefined) {
			const other = written.value;
			const found = this.#db.read((q) => current(q, other));
			if (!found.ok) return discard(found);
			return discard(await this.#resume(found.value, repo));
		}
		return ok({
			kind: 'created',
			report: summaryOf(report, revision),
			autoIgnored: sorted.ignored,
			closed: replacing
		});
	}

	async #check(found: Current, repo: LocalRepository): Promise<Result<SourceCheck, ReportError>> {
		const { report, revision } = found;
		const spec = report.source.spec;
		const fingerprint = await sourceIdentity(repo, spec);
		if (!fingerprint.ok) return fingerprint;
		if (fingerprint.value === revision.fingerprint) return ok({ kind: 'unchanged' });
		const remembered = this.#checks.get(report.id);
		if (remembered?.revision === revision.id && remembered.fingerprint === fingerprint.value) {
			return ok(remembered.outcome);
		}
		const probe = await snapshotGitSource(this.#dataDirectory, repo, spec, this.#ids.snapshotId());
		if (!probe.ok) return probe;
		const { snapshot } = probe.value;
		let empty = false;
		let outcome: SourceCheck = { kind: 'unchanged' };
		if (snapshot.base !== revision.baseTree || snapshot.head !== revision.headTree) {
			const files = await readSnapshotDiff(snapshot);
			if (!files.ok) {
				await deleteSnapshot(snapshot.store, snapshot.id);
				return files;
			}
			empty = files.value.length === 0;
			outcome = { kind: 'changed' };
		}
		// Applying an update is a later step; until then the probe is not kept.
		await deleteSnapshot(snapshot.store, snapshot.id);
		if (empty) {
			const uncommitted = spec.kind === 'working-tree' || spec.kind === 'staged';
			const since: CommitsSince = uncommitted
				? await commitsSince(repo, revision.baseCommit)
				: { kind: 'unknown' };
			outcome = { kind: 'nothing-left', ...nothingLeft(spec, since) };
		}
		this.#checks.set(report.id, { revision: revision.id, fingerprint: fingerprint.value, outcome });
		return ok(outcome);
	}

	/**
	 * Reads the current revision's diff, then runs `change` on its state in one
	 * write transaction and stores the state and marks it returns, with the
	 * revision's progress. Tried again if a new revision appeared meanwhile.
	 */
	async #changeState<T>(
		id: ReportId,
		change: (
			q: Queries,
			revision: Revision,
			diff: Diff,
			state: AssignmentState,
			marks: ReviewedMarks
		) => Result<{ result: T; state: AssignmentState; marks: ReviewedMarks }, ReportError>
	): Promise<Result<T, ReportError>> {
		for (let attempt = 0; ; attempt += 1) {
			const found = this.#db.read((q) => currentOpen(q, id));
			if (!found.ok) return found;
			const { report, revision } = found.value;
			const snapshot = await this.#snapshotOf(report, revision);
			if (!snapshot.ok) return snapshot;
			const diff = await this.#diffOf(snapshot.value);
			if (!diff.ok) return diff;
			const written = this.#db.write(
				(q): Result<{ stale: true } | { stale: false; result: T }, ReportError> =>
					andThen(
						currentOpen(q, id),
						(now): Result<{ stale: true } | { stale: false; result: T }, ReportError> => {
							if (now.revision.id !== revision.id) return ok({ stale: true });
							return andThen(stateOf(q, revision, diff.value), ({ state, marks }) =>
								andThen(change(q, revision, diff.value, state, marks), (changed) => {
									setRevisionProgress(
										q,
										revision.id,
										unitProgressOf(
											reviewProgress(diff.value, changed.state, changed.marks, 'sections')
										)
									);
									touchReport(q, id, this.#clock.now());
									return ok({ stale: false, result: changed.result });
								})
							);
						}
					)
			);
			if (!written.ok) return written;
			if (!written.value.stale) return ok(written.value.result);
			if (attempt + 1 >= RETRIES) return err({ kind: 'RevisionChangedWhileSaving', report: id });
		}
	}

	/** A snapshot's diff, read once and kept for the next few requests. */
	#diffOf(snapshot: Snapshot): Promise<Result<Diff, ReportError>> {
		const key = `${snapshot.store.id}/${snapshot.id}`;
		const cached = this.#diffs.get(key);
		if (cached !== undefined) {
			// Most recently used last.
			this.#diffs.delete(key);
			this.#diffs.set(key, cached);
			return cached;
		}
		const reading = readSnapshotDiff(snapshot).then((files): Result<Diff, ReportError> =>
			files.ok ? makeDiff(files.value) : files
		);
		this.#diffs.set(key, reading);
		void reading.then((result) => {
			if (!result.ok) this.#diffs.delete(key);
		});
		while (this.#diffs.size > CACHED_DIFFS) {
			const oldest = this.#diffs.keys().next();
			if (oldest.done === true) break;
			this.#diffs.delete(oldest.value);
		}
		return reading;
	}

	async #removeSnapshots(snapshots: readonly StoredSnapshot[]): Promise<Deleted> {
		const byStore = new Map<StoreId, SnapshotId[]>();
		for (const s of snapshots) byStore.set(s.store, [...(byStore.get(s.store) ?? []), s.snapshot]);
		let count = 0;
		for (const [storeId, ids] of byStore) {
			const store = await openStore(this.#dataDirectory, storeId);
			// A store that is gone holds nothing to remove.
			if (!store.ok && store.error.kind === 'StoreNotFound') continue;
			if (!store.ok)
				return { snapshots: snapshotCountOf(count), storeProblem: notFreed(store.error) };
			for (const id of ids) {
				this.#diffs.delete(`${storeId}/${id}`);
				const deleted = await deleteSnapshot(store.value, id);
				if (!deleted.ok && deleted.error.kind !== 'SnapshotNotFound') {
					return {
						snapshots: snapshotCountOf(count),
						storeProblem: notFreed(deleted.error)
					};
				}
				count += 1;
			}
			const collected = await collectGarbage(store.value);
			if (!collected.ok)
				return {
					snapshots: snapshotCountOf(count),
					storeProblem: notFreed(collected.error)
				};
		}
		return { snapshots: snapshotCountOf(count), storeProblem: undefined };
	}
}
