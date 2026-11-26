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
 *
 * A report is brought up to date only when asked (DESIGN 6.2): `update`, or
 * opening its source again, which is a request to see the files as they are
 * now. Either takes a new snapshot (or the one `checkForChanges` took to see
 * the change, when it is still the one needed), carries the sections, the
 * agent's sorting and the reviewer's marks over to it (`#lib/core/update`),
 * and makes the next revision in one transaction. Earlier revisions stay
 * stored, with their snapshots.
 */
import { isUtf8 } from 'node:buffer';
import { escapedRepoPath } from '#lib/core/path-bytes.ts';
import { FILE_MATCHES, MOST_FILE_BYTES, fileMatchScore } from '#lib/core/viewer/file-reader.ts';
import { MOST_BYTES_TO_COLOUR } from '#lib/core/highlight/limits.ts';
import type { FileMatch, FileReaderView } from '#lib/api/schemas.ts';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import type { Clock } from '#lib/core/clock.ts';
import type { CommitId } from '#lib/core/commit-id.tiny.ts';
import type { BranchRef } from '#lib/core/history/branch-ref.tiny.ts';
import type { LastFetch } from '#lib/core/history/history-words.ts';
import { assign, type AssignOutcome, type AssignRequest } from '#lib/core/diff/assign.ts';
import { autoIgnore, type AutoIgnored } from '#lib/core/diff/auto-ignore.ts';
import type { ByteSize } from '#lib/core/byte-size.tiny.ts';
import { makeDiff, type Diff, type DiffFile } from '#lib/core/diff/diff.ts';
import type { FileVersion } from '#lib/core/diff/file-diff.ts';
import { describeFileChange } from '#lib/core/diff/file-unit.ts';
import { fileModeKind } from '#lib/core/file-mode.tiny.ts';
import {
	bytesToKnowFormat,
	imageFormatOf,
	MAX_IMAGE_SIZE,
	namedAsImage,
	type ImageFormat,
	type NotImageKind
} from '#lib/core/image/image-format.ts';
import { fileSlices, groupKeyId, type GroupKey, type ViewKind } from '#lib/core/diff/slices.ts';
import { lineCountOf, type LineCount } from '#lib/core/line-count.tiny.ts';
import { lineNumberOf, type LineNumber } from '#lib/core/line-number.tiny.ts';
import type { Side } from '#lib/core/side.tiny.ts';
import { partBlocks, type LineSpan, type PartBlock } from '#lib/core/viewer/part-lines.ts';
import { frameOf, NO_PART_MARKS } from '#lib/core/viewer/parts.ts';
import {
	DiffSearchIndex,
	searchedLines,
	type DiffSearchOptions
} from '#lib/core/search/diff-search.ts';
import type { MatchCount } from '#lib/core/search/match-count.tiny.ts';
import type { SearchText } from '#lib/core/search/search-text.tiny.ts';
import { shownRepoPath } from '#lib/core/shown-path.tiny.ts';
import type { ColourRun } from '#lib/core/highlight/colour-run.ts';
import { languageOf } from '#lib/core/highlight/language.ts';
import { linesOf, looksBinary } from '#lib/core/file-text.ts';
import { ColourCache, type PlainReason } from '#lib/server/highlight/file-colours.ts';
import { DEFAULT_SETTINGS, type SettingChange, type ViewSettings } from '#lib/core/settings.ts';
import { readSettings, writeSetting } from '../db/tables/settings.ts';
import { initialState, type AssignmentState } from '#lib/core/diff/state.ts';
import type { IdSource } from '#lib/core/ids.ts';
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import type { ReportIdentity } from '#lib/core/report-identity.tiny.ts';
import {
	describeNothingToReview,
	reportTitle,
	repositoryLabel
} from '#lib/core/reports/describe-report.ts';
import {
	binaryBlobsOf,
	binaryFilesOf,
	diffSizeOf,
	type BinaryFiles
} from '#lib/core/reports/diff-size.ts';
import {
	nothingLeft,
	type CommitsSince,
	type NextSource,
	type NothingLeft
} from '#lib/core/reports/nothing-left.ts';
import { gitReportIdentity, pullRequestReportIdentity } from '#lib/core/reports/report-identity.ts';
import {
	sourceSpecOf,
	type Report,
	type ReportState,
	type Revision,
	type Section,
	type UnitProgress
} from '#lib/core/reports/report.ts';
import type { LineText } from '#lib/core/line-text.tiny.ts';
import type { TextForAgent } from '#lib/core/text-for-agent.tiny.ts';
import {
	applySectionChange,
	type SectionReferences,
	type SectionRequest
} from '#lib/core/reports/section-requests.ts';
import type { AgentMarkdown } from '#lib/core/agent-markdown.tiny.ts';
import { overviewOf, setOverview as storeOverview } from '../db/tables/overviews.ts';
import { referenceRowsFor, replaceReferenceRows } from '../db/tables/section-references.ts';
import type { DraftCommentId } from '#lib/core/draft-comment-id.tiny.ts';
import { NO_EDITS, type EditCount } from '#lib/core/edit-count.tiny.ts';
import {
	isCommentBody,
	type CommentAnchor,
	type DraftComment
} from '#lib/core/review/draft-comment.ts';
import {
	isOverallReviewBody,
	isWritten,
	storedOverallReview,
	type OverallReview
} from '#lib/core/review/overall-review.ts';
import {
	deleteDraftComment,
	renumberDraftComment,
	draftCommentOf,
	draftCommentsOf,
	insertDraftComment,
	updateDraftComment
} from '../db/tables/draft-comments.ts';
import { draftSummaryOf, writeDraftSummary } from '../db/tables/draft-summaries.ts';
import {
	insertReviewComments,
	reviewHolding,
	type ReviewCommentRow
} from '../db/tables/review-comments.ts';
import { copyReviewMarks } from '../db/tables/review-marks.ts';
import { insertReview, latestReviewNumber, reviewOf, reviewsOf } from '../db/tables/reviews.ts';
import { insertDelivery } from '../db/tables/review-deliveries.ts';
import {
	copyNotedReview,
	forgetPosting,
	noteAllInText,
	notePosting,
	reviewBeingPosted
} from '../db/tables/github-review-posts.ts';
import {
	gitHubReview,
	postedAs,
	reviewMarker,
	type GitHubPosting,
	type GitHubReviewDraft
} from '#lib/core/github/github-review.ts';
import { gitHubReviewAddress } from '#lib/core/github/github-review-address.tiny.ts';
import {
	MAX_QUOTED_LINES,
	notReviewed,
	renderReviewExport,
	type FinishedReview
} from '#lib/core/review/review-export.ts';
import { nextReviewNumber, type ReviewNumber } from '#lib/core/review-number.tiny.ts';
import { markReviewed, type ReviewTarget } from '#lib/core/review/mark-reviewed.ts';
import { reviewProgress, unitProgressOf, type Progress } from '#lib/core/review/progress.ts';
import { NO_MARKS, type ReviewedMarks } from '#lib/core/review/reviewed-marks.ts';
import { andThen, err, map, ok, type Result } from '#lib/core/result.ts';
import { repositoryNameOf } from '#lib/core/repository-name.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import {
	FIRST_REVISION,
	nextRevisionNumber,
	type RevisionNumber
} from '#lib/core/revision-number.tiny.ts';
import type { SnapshotId } from '#lib/core/snapshot-id.tiny.ts';
import type { SourceIdentity } from '#lib/core/source-identity.tiny.ts';
import type { GitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import type { SourceSpec } from '#lib/core/sources/source-spec.ts';
import type { RemoteName } from '#lib/core/history/remote-name.tiny.ts';
import {
	preferredGitHubRemote,
	sameGitHubRepository,
	type GitHubRepository
} from '#lib/core/github/github-repository.ts';
import {
	describePullRequest,
	describePullRequestNothingToReview,
	pullRequestIdentityParts,
	pullRequestNothingLeft,
	type PullRequestChange,
	type PullRequestRef
} from '#lib/core/github/pull-request.ts';
import { pullRequestTitleOf } from '#lib/core/github/pull-request-title.tiny.ts';
import type { GitHubEtag } from '#lib/core/github/github-etag.tiny.ts';
import type { GitHubHost } from '#lib/core/github/github-host.tiny.ts';
import {
	fetchKey,
	forgetPullRequestFetches,
	gitHubRemoteOf,
	gitHubRemotesOf,
	listOpenPullRequests,
	machineGitHubAccess,
	pullRequestFingerprint,
	readPullRequest,
	removeHalfKeptFetches,
	snapshotPullRequest,
	findReview,
	postReview,
	problemOf,
	type GitHubReviewFound,
	type ReviewPostProblem,
	type GitHubAccess,
	type GitHubApiError,
	type GitHubRateLimited,
	type KeptFetch,
	type OpenPullRequests,
	type PullRequestDetails
} from '../sources/github/index.ts';
import { writePullRequestText } from '../db/tables/pull-requests.ts';
import {
	assignmentRowsOf,
	assignmentStateFromRows,
	changedAssignmentPaths,
	pathsMissingFileUnit,
	reviewedMarksFromRows,
	reviewedRowsOf,
	unitRowsOf,
	unitSetFromRows,
	type AssignmentRow,
	type ReviewedRow,
	type UnitRow
} from '#lib/core/storage/stored-units.ts';
import { withoutUnits, type UnitSet } from '#lib/core/diff/unit-set.ts';
import { carryOver, carryUnitSets } from '#lib/core/update/carry-over.ts';
import { coverage } from '#lib/core/diff/coverage.ts';
import type { SectionId } from '#lib/core/section-id.tiny.ts';
import type { TreeChanges } from '#lib/core/update/line-map.ts';
import type { UpdateSummary } from '#lib/core/update/update-summary.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import type { StoreId } from '#lib/core/store-id.tiny.ts';
import { timeBetween } from '#lib/core/timestamp.tiny.ts';
import { fileCountOf, type FileCount } from '#lib/core/file-count.tiny.ts';
import { snapshotCountOf, type SnapshotCount } from '#lib/core/snapshot-count.tiny.ts';
import { NO_UNITS, type UnitCount } from '#lib/core/unit-count.tiny.ts';
import { Database, type DatabaseError, type Queries } from '../db/index.ts';
import { assignmentRowsFor } from '../db/tables/assignments.ts';
import {
	deleteReportRow,
	everyReport,
	insertReport,
	openReportFor,
	reportById,
	reportExists,
	setReportRepository,
	setReportState,
	touchReport
} from '../db/tables/reports.ts';
import { insertNewUnitRows, newUnitRowsFor } from '../db/tables/new-units.ts';
import {
	insertUnmarkedUnitRows,
	replaceUnmarkedUnitRows,
	unmarkedUnitRowsFor
} from '../db/tables/unmarked-units.ts';
import { replaceReviewedRows, reviewedRowsFor } from '../db/tables/reviewed-marks.ts';
import { insertRevisionUpdate, revisionUpdateFor } from '../db/tables/revision-updates.ts';
import {
	currentRevision,
	currentRevisions,
	insertRevision,
	revisionsOf,
	revisionAt,
	revisionsWithoutBinary,
	setRevisionBinary,
	setRevisionProgress,
	snapshotInUse,
	snapshotsInUse,
	snapshotsOfReport
} from '../db/tables/revisions.ts';
import { sectionsOf } from '../db/tables/sections.ts';
import { writesElsewhere } from '../db/data-version.ts';
import { SortingWrites } from './sorting-writes.ts';
import { FrameVersions } from './frame-versions.ts';
import { checkedRevision, isToCheck, revisionsToCheck } from '../db/tables/revisions-to-check.ts';
import {
	forgetSnapshot,
	noticeSnapshot,
	sightingsIn
} from '../db/tables/unreferenced-snapshots.ts';
import {
	checkRemote,
	commitsSince,
	headCommit,
	readCommitRun,
	lastFetch,
	listBranches,
	listCommits,
	mainBranch,
	rangeSize,
	remotesOf,
	trackedBranches,
	type Branches,
	type CommitPage,
	type CommitSize,
	type PageStart,
	type RemoteOutcome,
	locateRepository,
	snapshotGitSource,
	sourceHasChanges,
	sourceIdentity,
	suggestSource,
	type GitSnapshot,
	type LocalRepository,
	type RepositoryOptions,
	type SourceCandidate,
	type SuggestedSource
} from '../sources/git/index.ts';
import {
	checkStoreUsable,
	collectGarbage,
	deleteSnapshot,
	describeStoreError,
	generatedPaths,
	GRACE_PERIOD,
	listSnapshots,
	listSnapshotPaths,
	snapshotEntry,
	listStores,
	openSnapshotRef,
	openStore,
	removeStaleFolders,
	readBlobSizes,
	readSnapshotDiff,
	readSnapshotFile,
	readSnapshotFileStart,
	readSnapshotLines,
	readTreeDiff,
	type Snapshot,
	type SnapshotLines,
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
	/**
	 * Where details only a bug report needs are written, such as which table and
	 * column of a damaged entry could not be read: the daemon's log. Standard
	 * error by default.
	 */
	readonly log?: (line: string) => void;
	/**
	 * How GitHub is reached, for pull requests: by default its API and the
	 * person's sign-in from `gh` or `GITHUB_TOKEN`. Tests give a stand-in's.
	 */
	readonly github?: GitHubAccess;
}

/**
 * How long, by the service's clock, what GitHub said of a pull request is
 * taken as still true by a page's check for changes, so a page that checks
 * often asks GitHub at most this often. Opening it and updating it, which a
 * person asks for, always ask again.
 */
export const PULL_REQUEST_CHECK_EVERY_MS = 60_000;

/**
 * How often a page's check asks GitHub when the person is not signed in:
 * GitHub allows a computer only 60 requests an hour then, and counts even
 * the answers that say nothing has changed.
 */
export const PULL_REQUEST_CHECK_SIGNED_OUT_EVERY_MS = 300_000;

/** How long to leave GitHub alone after it refused for too many requests without saying. */
const RATE_LIMIT_WAIT_SECONDS = 60;

/** Where a refusal for too many requests is kept: GitHub counts a host's requests by who asks. */
function rateLimitKey(host: GitHubHost, signedIn: boolean): string {
	return `${host}/${signedIn ? 'signed-in' : 'signed-out'}`;
}

/**
 * Who asks what GitHub says of a pull request: a page's check, which takes
 * what it said within the last minute (five, signed out); a person, who
 * opened it, updated it or ran the command, and is asked for now; or a
 * snapshot, which takes what was asked just before.
 */
type GitHubAsking = 'check' | 'person' | 'just-asked';

/** What GitHub last said of a pull request, kept by the service. */
interface KeptPullRequest {
	/** When GitHub last gave its details, or said they had not changed. */
	readonly at: Timestamp;
	readonly details: PullRequestDetails;
	/** The tag of the answer that gave the details, to ask with next. */
	readonly etag: GitHubEtag | undefined;
	/** Whether it was last asked signed in, which says how often a page's check asks again. */
	readonly signedIn: boolean;
}

function checkEvery(signedIn: boolean): number {
	return signedIn ? PULL_REQUEST_CHECK_EVERY_MS : PULL_REQUEST_CHECK_SIGNED_OUT_EVERY_MS;
}

/** A report as a list or a page header shows it. */
export interface ReportSummary {
	readonly id: ReportId;
	/** The source in plain words: "Uncommitted changes", "feature compared with main". */
	readonly title: ReviewerMessage;
	/** The repository's folder name: "diff-delver". */
	readonly repository: ReviewerMessage;
	/** Where the repository was opened. */
	readonly repositoryPath: Report['repositoryPath'];
	readonly state: ReportState;
	readonly createdAt: Report['createdAt'];
	readonly lastActivityAt: Report['lastActivityAt'];
	/** The current revision's number, size, binary files and progress. */
	readonly revision: Revision['number'];
	readonly size: Revision['size'];
	readonly binary: Revision['binary'];
	readonly progress: Revision['progress'];
	/** How many files could not be included; the report page lists them. */
	readonly leftOut: FileCount;
}

/**
 * A report in the list. One whose saved rows cannot be read is listed as
 * damaged, beside the others, so the reviewer can see it and delete it.
 */
export type ListedReport = ({ readonly kind: 'report' } & ReportSummary) | DamagedReport;

/**
 * A report whose saved rows cannot be read. `deleteReport` removes it. Which
 * table and column could not be read goes to the log, not to the reviewer.
 */
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
	/**
	 * The source's open report, brought up to date first when its source had
	 * moved on: `update` says what the update did, and is undefined when nothing
	 * had changed.
	 */
	| {
			readonly kind: 'resumed';
			readonly report: ReportSummary;
			readonly update: UpdateSummary | undefined;
	  }
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
	| {
			readonly kind: 'choose';
			/** The repository's folder name, for the heading of the start page's choice. */
			readonly repository: ReviewerMessage;
			readonly candidates: readonly SourceCandidate[];
	  }
	| {
			readonly kind: 'nothing';
			readonly reason: ReviewerMessage;
			readonly candidates: readonly SourceCandidate[];
	  }
	/** The likely source could not be opened: `problem` says why. */
	| {
			readonly kind: 'failed';
			readonly tried: SourceCandidate;
			readonly problem: ReportError;
			/** Other sources worth offering instead. */
			readonly others: readonly SourceCandidate[];
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
	/** Each section's cross-references (DESIGN 4.3); a section with none has no entry. */
	readonly references: SectionReferences;
	/** What the change does, as the agent wrote it; undefined until it has. */
	readonly overview: AgentMarkdown | undefined;
	readonly frame: string;
	readonly sorting: string;
	readonly assignments: string;
	readonly state: AssignmentState;
	readonly reviewed: ReviewedMarks;
	/**
	 * Progress in the sections view, its groups in reading order;
	 * `reviewProgress` gives it for the other view.
	 */
	readonly progress: Progress;
	/** Files that could not be included, one sentence each. */
	readonly leftOut: readonly ReviewerMessage[];
	/** What the update that made the current revision did; undefined for a first revision. */
	readonly update: LastUpdate | undefined;
	/** The units new since the previous revision; empty for a first revision. */
	readonly fresh: UnitSet;
	/**
	 * The units the update that made this revision unmarked because something
	 * close to them changed; empty for a first revision. Some may have been
	 * marked again since.
	 */
	readonly unmarked: UnitSet;
}

/** What the update that made a report's current revision did, for its page. */
export interface LastUpdate {
	/** The revision it made, which the page calls the version. */
	readonly revision: RevisionNumber;
	readonly at: Timestamp;
	readonly summary: UpdateSummary;
}

/** What `update` did. */
export type UpdateOutcome =
	/** A new revision, as the files are now. */
	| { readonly kind: 'updated'; readonly report: ReportSummary; readonly summary: UpdateSummary }
	/** The source has not changed since the current revision; nothing was made. */
	| { readonly kind: 'unchanged'; readonly report: ReportSummary }
	/**
	 * The source has nothing left to review (DESIGN 6.1); nothing was made, and
	 * the report stays open and readable.
	 */
	| ({ readonly kind: 'nothing-left'; readonly report: ReportSummary } & NothingLeft);

/** What marking did. */
export interface MarkOutcome {
	readonly reviewed: ReviewedMarks;
	readonly progress: Progress;
	/** How many units the target covers. */
	readonly units: UnitCount;
	/** The files whose marks may have changed. */
	readonly files: ReadonlySet<RepoPath>;
}

/** One side of a file, coloured by language: the lines asked for that have colour, or why it is plain. */
export type SideColours =
	| {
			readonly kind: 'coloured';
			readonly lines: readonly {
				readonly number: LineNumber;
				readonly runs: readonly ColourRun[];
			}[];
	  }
	| { readonly kind: 'plain'; readonly reason: PlainReason };

/** The colours of lines of both sides of a file (`readColours`). */
export interface PartColours {
	readonly old: SideColours | undefined;
	readonly new: SideColours | undefined;
}

/**
 * One side of a file a part shows as an image (DESIGN 8.4): a picture, with
 * its format and size, and the same when it is larger than the page shows;
 * or what it is instead when it is no picture, such as the other side of an
 * image renamed to a name that is not an image's, or replaced by bytes that
 * are not one.
 */
export type ImageSide =
	| { readonly kind: 'image'; readonly format: ImageFormat; readonly size: ByteSize }
	| { readonly kind: 'too-large'; readonly format: ImageFormat; readonly size: ByteSize }
	| { readonly kind: 'other'; readonly what: NotImageKind; readonly size: ByteSize };

/**
 * A file at least one side of which is an image: each side, undefined where
 * the file does not have it, and whether its bytes are the same on both.
 */
export interface PartImage {
	readonly old: ImageSide | undefined;
	readonly new: ImageSide | undefined;
	readonly sameBytes: boolean;
	/**
	 * For a binary file every side of which is an image, how it changed in the
	 * words of its part's header ("changed, image"); undefined otherwise.
	 */
	readonly change: ReviewerMessage | undefined;
}

/** One side of an image, to serve as it is (`readImage`). */
export interface ImageFile {
	readonly format: ImageFormat;
	readonly bytes: Uint8Array;
}

/** What one part of a revision shows when it is open (`partBlocks`). */
export interface PartContent {
	readonly file: DiffFile;
	readonly blocks: readonly PartBlock[];
	/** For a binary file, its size on each side it has; undefined for any other file. */
	readonly sizes:
		{ readonly old: ByteSize | undefined; readonly new: ByteSize | undefined } | undefined;
	/** For an image, a side of which is one the page shows as a picture; undefined for any other file. */
	readonly image: PartImage | undefined;
}

/** One part's matches, for a search of the diff (`searchDiff`). */
export interface PartMatches {
	readonly group: GroupKey;
	readonly path: RepoPath;
	readonly matches: MatchCount;
}

/** Every part of a revision as a search reads it, in reading order, with its group and path. */
interface SearchIndex {
	readonly parts: readonly { readonly group: GroupKey; readonly path: RepoPath }[];
	readonly index: DiffSearchIndex;
}

/** Whether an open report's source has moved on since its current revision. */
type SourceCheck =
	/** Nothing changed, or the fingerprint raised a false alarm. */
	| { readonly kind: 'unchanged' }
	/**
	 * The trees differ: an update is waiting, which would change `files` files;
	 * for a pull request, with what changed on GitHub.
	 */
	| {
			readonly kind: 'changed';
			readonly files: FileCount;
			readonly pullRequest?: PullRequestChange;
	  }
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
	| { readonly kind: 'report-closed' }
	/**
	 * The report has a newer revision than the one the asker has seen, such as
	 * one the command made while a page was open: the page shows stale content.
	 */
	| { readonly kind: 'updated'; readonly revision: RevisionNumber };

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

const FIRST_LINE = lineNumberOf(1);

/** How many diffs to keep in memory: the reports a reviewer has open at once. */
const CACHED_DIFFS = 8;

/** How many diffs' search indexes to keep in memory, most recently searched last. */
const CACHED_SEARCH_INDEXES = 4;

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

interface StoredFrame extends Stored {
	readonly fresh: readonly UnitRow[];
	readonly unmarked: readonly UnitRow[];
	readonly summary: UpdateSummary | undefined;
	readonly referenceRows: ReadonlyMap<SectionId, readonly UnitRow[]>;
	readonly overview: AgentMarkdown | undefined;
	readonly shown: Current;
	readonly sorting: string;
	readonly assignments: string;
}

/** A new snapshot of a report's source and what carrying over to it needs, read from the store. */
interface Prepared {
	readonly taken: GitSnapshot;
	readonly diff: Diff;
	readonly heads: TreeChanges;
	readonly bases: TreeChanges;
	readonly generated: ReadonlySet<RepoPath>;
	readonly binary: BinaryFiles;
}

/** What a look at the source found, against the report's current revision. */
type Probe =
	| { readonly kind: 'unchanged' }
	| ({ readonly kind: 'nothing-left' } & NothingLeft)
	| { readonly kind: 'changed'; readonly prepared: Prepared };

/**
 * The last check of a report's source, for its current revision and the
 * fingerprint it saw. For a change it keeps the snapshot it took, so the
 * update that follows uses it instead of taking another.
 */
interface Remembered {
	readonly revision: Revision['id'];
	readonly fingerprint: SourceIdentity;
	readonly outcome: SourceCheck;
	readonly prepared: Prepared | undefined;
}

/** What a delete says when its rows went but its snapshots could not be removed yet. */
function notFreed(error: StoreError): ReviewerMessage {
	return reviewerMessage(
		`The Delve was deleted, but the space its saved changes use could not be freed yet; diff delver frees it by itself later. What went wrong: ${describeStoreError(error)}`
	);
}

/** A diff's binary files with their sizes, read from the store in one call. */
async function binaryOf(snapshot: Snapshot, diff: Diff): Promise<Result<BinaryFiles, ReportError>> {
	const sizes = await readBlobSizes(snapshot, binaryBlobsOf(diff));
	return sizes.ok ? ok(binaryFilesOf(diff, sizes.value)) : sizes;
}

/** How `#held` names a snapshot. */
function heldKey(store: StoreId, snapshot: SnapshotId): string {
	return `${store}/${snapshot}`;
}

/** A repository as the choose page shows it. */
export interface RepositoryBranches {
	/** Its folder's name. */
	readonly repository: ReviewerMessage;
	readonly branches: Branches;
	readonly lastFetch: LastFetch;
	/** The repository has no commits yet: no branch, and nothing checked out. */
	readonly noCommits: boolean;
	/** Its remote on GitHub, read from its config, whose pull requests it offers; undefined for none. */
	readonly gitHub:
		{ readonly remote: RemoteName; readonly repository: GitHubRepository } | undefined;
}

/** A repository's open pull requests, as the choose page lists them. */
export interface RepositoryPullRequests {
	readonly remote: RemoteName;
	readonly repository: GitHubRepository;
	readonly pulls: OpenPullRequests;
}

/** What a look at a report's source before any snapshot found: its fingerprint, or that nothing is left. */
type Look =
	| { readonly kind: 'fingerprint'; readonly fingerprint: SourceIdentity }
	| ({ readonly kind: 'nothing-left' } & NothingLeft);

function worktreeOf(repo: LocalRepository): AbsolutePath {
	return repo.workTree ?? repo.gitDir;
}

/**
 * Whether the repository is a clone of the pull request's repository on
 * GitHub, whose objects opening it may borrow; `NotACloneOf` when it is not.
 */
async function cloneOf(
	repo: LocalRepository,
	pullRequest: PullRequestRef
): Promise<Result<void, ReportError>> {
	const remotes = await gitHubRemotesOf(repo);
	if (!remotes.ok) return remotes;
	if (remotes.value.some((r) => sameGitHubRepository(r.repository, pullRequest.repository))) {
		return ok(undefined);
	}
	return err({
		kind: 'NotACloneOf',
		directory: worktreeOf(repo),
		wanted: pullRequest.repository,
		found: preferredGitHubRemote(remotes.value)?.repository
	});
}

function summaryOf(report: Report, revision: Revision): ReportSummary {
	return {
		id: report.id,
		title: reportTitle(report.source),
		repository: repositoryLabel(report.repositoryPath),
		repositoryPath: report.repositoryPath,
		state: report.state,
		createdAt: report.createdAt,
		lastActivityAt: report.lastActivityAt,
		revision: revision.number,
		size: revision.size,
		binary: revision.binary,
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

/** Like `current`, with the revision numbered `version` when one is given. */
function asOf(
	q: Queries,
	id: ReportId,
	version: RevisionNumber | undefined
): Result<Current, ReportError> {
	return andThen(current(q, id), (found): Result<Current, ReportError> => {
		const latest = found.revision.number;
		if (version === undefined || version === latest) return ok(found);
		return andThen(revisionAt(q, id, version), (revision) => {
			return revision === undefined
				? err({ kind: 'VersionNotFound', report: id, seen: version, current: latest })
				: ok({ report: found.report, revision });
		});
	});
}

/** Like `current`, for a change: the report must be open. */
function currentOpen(q: Queries, id: ReportId): Result<Current, ReportError> {
	return andThen(current(q, id), (found) =>
		found.report.state.kind === 'open' ? ok(found) : err({ kind: 'ReportClosed', report: id })
	);
}

/**
 * Like `currentOpen`, for a change the caller made on what it saw: the current
 * revision must be the one the caller saw, or the change is refused, never made
 * on a newer one.
 */
function currentAsSeen(
	q: Queries,
	id: ReportId,
	seen: RevisionNumber
): Result<Current, ReportError> {
	return andThen(currentOpen(q, id), (found): Result<Current, ReportError> => {
		const current = found.revision.number;
		if (current === seen) return ok(found);
		return err({
			kind: seen > current ? 'VersionNotFound' : 'VersionOutOfDate',
			report: id,
			seen,
			current
		});
	});
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

/** Each section's cross-references, as rows to store. */
function referenceRowsOf(
	references: SectionReferences
): ReadonlyMap<SectionId, readonly UnitRow[]> {
	return new Map([...references].map(([section, set]) => [section, unitRowsOf(set)]));
}

/** The cross-references the rows describe, checked against the diff. */
function referencesFromRows(
	diff: Diff,
	rows: ReadonlyMap<SectionId, readonly UnitRow[]>
): Result<SectionReferences, ReportError> {
	const references = new Map<SectionId, UnitSet>();
	for (const [section, list] of rows) {
		const set = unitSetFromRows(diff, list, 'cross-references');
		if (!set.ok) return set;
		references.set(section, set.value);
	}
	return ok(references);
}

/** A revision's cross-references, read and checked against its diff. */
function referencesOf(
	q: Queries,
	revision: RevisionId,
	diff: Diff
): Result<SectionReferences, ReportError> {
	return andThen(referenceRowsFor(q, revision), (rows) => referencesFromRows(diff, rows));
}

/** What writing an update did: made the next revision, or found the current one had changed. */
type Written =
	| 'stale'
	| {
			readonly report: ReportSummary;
			readonly revision: Revision;
			readonly summary: UpdateSummary;
	  };

/** What `carryOver` needs, from the current revision and the snapshot prepared for the next. */
function carryOverInput(
	diff: Diff,
	state: AssignmentState,
	marks: ReviewedMarks,
	prepared: Prepared
): Parameters<typeof carryOver>[0] {
	return {
		previous: { diff, state, marks },
		diff: prepared.diff,
		heads: prepared.heads,
		bases: prepared.bases,
		autoIgnore: { markedGenerated: prepared.generated }
	};
}

/** A comment of the draft as a page showed it: which, and how many times its words had been changed. */
export interface ShownComment {
	readonly id: DraftCommentId;
	readonly edits: EditCount;
}

/** The draft as a page showed it: its comments, and how many times its overall review had been changed. */
export interface ShownDraft {
	readonly comments: readonly ShownComment[];
	readonly overall: EditCount;
}

/** What finishing the draft now would hand over. */
export interface ReviewPreview {
	/** The number the review would take. */
	readonly number: ReviewNumber;
	readonly text: TextForAgent;
	/** The draft's comments it holds, as they are now. */
	readonly comments: readonly DraftComment[];
	/** The draft's overall review, as it is now. */
	readonly overall: OverallReview;
}

/**
 * A review just finished, and when it is one an earlier post had put on
 * GitHub, whose answer never came, found there and recorded as it was sent:
 * whether anything added or changed since stays in the draft.
 */
export interface JustFinished extends FinishedReview {
	readonly earlier: { readonly draftKept: boolean } | undefined;
}

/** The draft as stored: its comments and its overall review. */
interface Draft {
	readonly comments: readonly DraftComment[];
	readonly overall: OverallReview;
}

interface PreparedReview {
	readonly found: Current;
	readonly diff: Diff;
	readonly draft: Draft;
	/** The code each comment of the draft is on, in the same order. */
	readonly quoted: readonly (readonly LineText[])[];
}

interface ReviewText {
	readonly number: ReviewNumber;
	readonly text: TextForAgent;
	readonly progress: UnitProgress;
	readonly comments: readonly ReviewCommentRow[];
}

/** Whether the draft holds exactly the comments shown, each with the words shown, and the overall review shown. */
function sameDraft(draft: Draft, shown: ShownDraft): boolean {
	if (draft.overall.edits !== shown.overall) return false;
	if (draft.comments.length !== shown.comments.length) return false;
	const edits = new Map(shown.comments.map((c) => [c.id, c.edits]));
	return draft.comments.every((c) => edits.get(c.id) === c.edits);
}

/** Whether the draft holds anything to finish: a comment, or an overall review. */
function anythingToFinish(draft: Draft): boolean {
	return draft.comments.length > 0 || isWritten(draft.overall.body);
}

/** The Delve's draft as stored. */
function draftOf(q: Queries, report: ReportId): Result<Draft, ReportError> {
	return andThen(draftCommentsOf(q, report), (comments) =>
		andThen(draftSummaryOf(q, report), (overall) => ok({ comments, overall }))
	);
}

/**
 * Whether the draft may be finished as a page showed it: only when it holds
 * exactly the comments shown, each with the words shown, and the overall
 * review shown, and at least one comment or an overall review.
 * When the comments shown are no longer in the draft because they were
 * finished, as from another tab, it says as which review.
 */
function finishable(
	q: Queries,
	report: ReportId,
	draft: Draft,
	shown: ShownDraft
): Result<undefined, ReportError> {
	if (sameDraft(draft, shown)) {
		return anythingToFinish(draft) ? ok(undefined) : err({ kind: 'NothingToFinish' });
	}
	const inDraft = new Set(draft.comments.map((c) => c.id));
	for (const comment of shown.comments) {
		if (inDraft.has(comment.id)) continue;
		const holding = reviewHolding(q, report, comment.id);
		if (!holding.ok) return holding;
		if (holding.value !== undefined)
			return err({ kind: 'CommentsFinished', number: holding.value });
	}
	return err({ kind: 'DraftChanged' });
}

/** Why a comment is not in the draft: finished as part of a review, or deleted. */
function notInDraft(
	q: Queries,
	report: ReportId,
	comment: DraftCommentId
): Result<never, ReportError> {
	const holding = reviewHolding(q, report, comment);
	if (!holding.ok) return holding;
	return err(
		holding.value === undefined
			? { kind: 'CommentNotFound' }
			: { kind: 'CommentFinished', number: holding.value }
	);
}

/** The draft's comments as a finished review keeps them, each on the revision it was written on. */
function frozenComments(
	q: Queries,
	report: ReportId,
	draft: readonly DraftComment[],
	quoted: readonly (readonly LineText[])[]
): Result<readonly ReviewCommentRow[], ReportError> {
	const rows: ReviewCommentRow[] = [];
	for (const [i, c] of draft.entries()) {
		const revision = revisionAt(q, report, c.version);
		if (!revision.ok) return revision;
		if (revision.value === undefined) {
			return err({
				kind: 'StoredRowInvalid',
				table: 'draft_comments',
				detail: `a comment on version ${String(c.version)}, which the Delve does not have`
			});
		}
		rows.push({
			draft: c.id,
			revision: revision.value.id,
			comment: { anchor: c.anchor, version: c.version, body: c.body, quoted: quoted[i] ?? [] },
			writtenAt: c.writtenAt
		});
	}
	return ok(rows);
}

/**
 * Whether GitHub surely made no review of a post that failed so, so that
 * nothing needs looking for on GitHub before the next: it refused it, or it
 * was never asked. Otherwise, as when it did not answer in time, the review
 * may be there.
 */
function surelyNotPosted(problem: ReviewPostProblem): boolean {
	switch (problem.kind) {
		case 'unreachable':
		case 'unanswered':
		case 'unreadable':
			return false;
		case 'signed-out':
		case 'sign-in-refused':
		case 'not-allowed':
		case 'rate-limited':
		case 'pending-review-exists':
		case 'own-pull-request':
		case 'refused':
		case 'lines-refused':
		case 'closed':
		case 'being-posted':
		case 'no-commit':
			return true;
	}
}

export class ReportService {
	readonly #db: Database;
	readonly #dataDirectory: AbsolutePath;
	readonly #clock: Clock;
	readonly #ids: IdSource;
	readonly #repository: RepositoryOptions;
	readonly #diffs = new Map<string, Promise<Result<Diff, ReportError>>>();
	readonly #checks = new Map<ReportId, Remembered>();
	/**
	 * Snapshots taken and not yet referred to by a revision or deleted, as
	 * `store/snapshot`: the one a check keeps for the next update, and any an
	 * open, a check or an update is using. Tidying never removes them.
	 */
	readonly #held = new Set<string>();
	/** Stores snapshots were discarded from since they were last collected. */
	readonly #discarded = new Set<StoreId>();
	/** Checks under way, by report and revision, so callers at the same time share one. */
	readonly #checking = new Map<string, Promise<Result<SourceCheck, ReportError>>>();
	readonly #log: (line: string) => void;
	/** What has been logged already, so a damaged entry is logged once, not on every listing. */
	readonly #logged = new Set<string>();
	/** Files' colours, kept by blob and language for the daemon's life. */
	readonly #colours: ColourCache;
	/**
	 * Search indexes of the diffs searched last, by revision, view and how the
	 * revision's lines are sorted, so sorting them again makes a new one.
	 */
	readonly #searchIndexes = new Map<string, SearchIndex>();
	/**
	 * Every write of a revision's sorting, its sections and which lines are in
	 * them, counted: the count is part of a search index's key.
	 */
	readonly #sorting = new SortingWrites();
	readonly #frameVersions = new FrameVersions();
	readonly #github: GitHubAccess;
	/** Delves whose draft is being posted to GitHub now, so it is neither posted nor finished twice. */
	readonly #posting = new Set<ReportId>();
	/** What GitHub last said of each pull request, by its identity, and when. */
	readonly #pullRequests = new Map<string, KeptPullRequest>();
	/**
	 * GitHub's last refusal to say of a pull request, other than for too many
	 * requests, by the pull request's identity: when, and for how many
	 * milliseconds it stands.
	 */
	readonly #pullRequestRefusals = new Map<
		string,
		{ readonly error: GitHubApiError; readonly at: Timestamp; readonly wait: number }
	>();
	/**
	 * GitHub's last refusal for too many requests, by host and whether it was
	 * asked signed in (`rateLimitKey`), since GitHub counts requests by account,
	 * or by computer for a person signed out, not by pull request: when, and for
	 * how many milliseconds it stands.
	 */
	readonly #rateLimits = new Map<
		string,
		{ readonly error: GitHubRateLimited; readonly at: Timestamp; readonly wait: number }
	>();

	private constructor(db: Database, options: ReportServiceOptions) {
		this.#db = db;
		this.#dataDirectory = options.dataDirectory;
		this.#clock = options.clock;
		this.#ids = options.ids;
		this.#repository = options.repository ?? {};
		this.#github = options.github ?? machineGitHubAccess();
		this.#log =
			options.log ??
			((line) => {
				console.error(line);
			});
		this.#colours = new ColourCache(this.#log);
	}

	/** Opens the service on a data directory, making its database if there is none. */
	static async open(options: ReportServiceOptions): Promise<Result<ReportService, DatabaseError>> {
		const db = await Database.open(options.dataDirectory, options.clock);
		if (!db.ok) return db;
		const service = new ReportService(db.value, options);
		await service.#checkOldRevisions();
		return ok(service);
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
				return ok(
					opened.ok
						? { kind: 'opened', opened: opened.value, others: suggestion.others }
						: {
								kind: 'failed',
								tried: suggestion.candidate,
								problem: opened.error,
								others: suggestion.others
							}
				);
			}
			case 'choose':
				return ok({
					kind: 'choose',
					repository: repositoryLabel(worktreeOf(repository)),
					candidates: suggestion.candidates
				});
			case 'nothing':
				return ok({
					kind: 'nothing',
					reason: suggestion.reason,
					candidates: suggestion.candidates
				});
		}
	}

	/**
	 * What the no-argument start would offer in `directory`, without opening
	 * anything: for the start page and its choice, which may be reloaded.
	 */
	async suggest(directory: AbsolutePath): Promise<Result<SuggestedSource, ReportError>> {
		return suggestSource(directory, this.#repository);
	}

	/**
	 * Whether a source can be opened in the repository at `directory`, without
	 * making a report: for the page that says why it could not be opened, which
	 * may be reloaded any number of times. Says what is wrong as `open` would,
	 * such as a branch git does not know, or else whether the source has changes
	 * to review. Cheap: no snapshot is taken, nothing is written to the store, and
	 * the repository is only read (`sourceHasChanges`).
	 */
	async checkSource(
		directory: AbsolutePath,
		spec: GitSourceSpec
	): Promise<Result<'changes' | 'nothing', ReportError>> {
		const repo = await locateRepository(directory, this.#repository);
		if (!repo.ok) return repo;
		const changes = await sourceHasChanges(repo.value, spec);
		if (!changes.ok) return changes;
		// Opening it would also need its store: say so if that cannot be made.
		const usable = await checkStoreUsable(this.#dataDirectory, repo.value.storeId);
		if (!usable.ok) return usable;
		return ok(changes.value ? 'changes' : 'nothing');
	}

	/**
	 * What the choose page shows of the repository at
	 * `directory`: its branches (with `find`, those whose name holds it), and
	 * when it last fetched. Only reads the repository.
	 */
	async branches(
		directory: AbsolutePath,
		find: string
	): Promise<Result<RepositoryBranches, ReportError>> {
		const repo = await locateRepository(directory, this.#repository);
		if (!repo.ok) return repo;
		const branches = await listBranches(repo.value, find);
		if (!branches.ok) return branches;
		// Only asked of a repository with no branch at all: one with a branch has commits.
		const none = find.trim() === '' && branches.value.shown.length === 0;
		const head = none ? await headCommit(repo.value) : undefined;
		if (head?.ok === false) return head;
		const gitHub = await gitHubRemoteOf(repo.value);
		if (!gitHub.ok) return gitHub;
		return ok({
			repository: repositoryLabel(worktreeOf(repo.value)),
			branches: branches.value,
			lastFetch: await lastFetch(repo.value, branches.value.remotes, branches.value.main),
			noCommits: head !== undefined && head.value === undefined,
			gitHub: gitHub.value
		});
	}

	/**
	 * The open pull requests of the repository at `directory`, from its remote
	 * on GitHub (`upstream`, then `origin`, first), most recently updated first: a network call,
	 * made only when a person asks for the list. `NotOnGitHub` when no remote
	 * of it is on GitHub. Writes nothing.
	 */
	async pullRequests(
		directory: AbsolutePath
	): Promise<Result<RepositoryPullRequests, ReportError>> {
		const repo = await locateRepository(directory, this.#repository);
		if (!repo.ok) return repo;
		const gitHub = await gitHubRemoteOf(repo.value);
		if (!gitHub.ok) return gitHub;
		if (gitHub.value === undefined)
			return err({ kind: 'NotOnGitHub', directory: worktreeOf(repo.value) });
		const { remote, repository } = gitHub.value;
		const limited = await this.#rateLimited(repository.host);
		if (limited !== undefined) return err(limited);
		const now = this.#clock.now();
		const pulls = await listOpenPullRequests(this.#github, repository, now);
		if (!pulls.ok) {
			this.#noteRateLimit(pulls.error, now);
			return pulls;
		}
		return ok({ remote, repository, pulls: pulls.value });
	}

	/**
	 * A page of a branch's commits, from `from` (a previous page's `next`) or its
	 * newest. Finds the main branch alone: no page measures the other branches.
	 */
	async commits(
		directory: AbsolutePath,
		branch: BranchRef,
		from: PageStart | undefined
	): Promise<Result<CommitPage, ReportError>> {
		const repo = await locateRepository(directory, this.#repository);
		if (!repo.ok) return repo;
		const main = await mainBranch(repo.value);
		if (!main.ok) return main;
		return listCommits(repo.value, branch, from, main.value);
	}

	/** The size of the diff a run of commits makes: `from` (undefined for nothing before) to `to`. */
	async runSize(
		directory: AbsolutePath,
		from: CommitId | undefined,
		to: CommitId
	): Promise<Result<CommitSize | undefined, ReportError>> {
		const repo = await locateRepository(directory, this.#repository);
		return repo.ok ? rangeSize(repo.value, from, to) : repo;
	}

	/**
	 * Asks each of the repository's remotes what its branches are at, at once,
	 * and compares them with what this copy last fetched. The only network call
	 * for a local repository, made only when a person asks; writes nothing.
	 */
	async checkRemotes(
		directory: AbsolutePath
	): Promise<Result<readonly RemoteOutcome[], ReportError>> {
		const repo = await locateRepository(directory, this.#repository);
		if (!repo.ok) return repo;
		const remotes = await remotesOf(repo.value);
		if (!remotes.ok) return remotes;
		const tracked = await trackedBranches(repo.value);
		if (!tracked.ok) return tracked;
		return ok(
			await Promise.all(
				remotes.value.map((remote) => checkRemote(repo.value, remote, tracked.value))
			)
		);
	}

	/**
	 * Opens a source in the repository at `directory`: resumes its open report,
	 * or takes a snapshot and makes a new report with revision 1, everything
	 * uncategorised except what the built-in rules ignore.
	 */
	async open(directory: AbsolutePath, spec: SourceSpec): Promise<Result<OpenOutcome, ReportError>> {
		const repo = await locateRepository(directory, this.#repository);
		if (!repo.ok) return repo;
		if (spec.kind === 'pull-request') {
			// A pull request is opened from a clone of its repository, whose objects it borrows.
			const clone = await cloneOf(repo.value, spec.pullRequest);
			if (!clone.ok) return clone;
		}
		return this.#openIn(repo.value, spec);
	}

	/**
	 * Everything a report page shows, from the database and the store; the
	 * repository is not touched. Its current revision, or with `version` that
	 * revision, so a page showing an earlier version keeps reading it after an
	 * update; a version it never had is `VersionNotFound`. Everything, the
	 * summary too, is of the revision loaded.
	 */
	async load(id: ReportId, version?: RevisionNumber): Promise<Result<LoadedReport, ReportError>> {
		const shown = this.#db.read((q) => asOf(q, id, version));
		if (!shown.ok) return shown;
		const { report } = shown.value;
		const content = await this.#contentOf(report, shown.value.revision);
		if (!content.ok) return content;
		const { snapshot, diff, revision } = content.value;
		const found = this.#db.read((q): Result<StoredFrame, ReportError> => {
			// Sample before reading the rows, so a concurrent commit cannot give
			// older rows a newer stamp. Both stamps are conservative on a race.
			const elsewhere = writesElsewhere(q);
			const sorting = this.#sortingOf(revision.id, elsewhere);
			const assignments = this.#assignmentsOf(revision.id, elsewhere);
			return andThen(asOf(q, id, revision.number), (shownNow) =>
				andThen(sectionsOf(q, revision.id), (sections) =>
					andThen(assignmentRowsFor(q, revision.id), (rows) =>
						andThen(reviewedRowsFor(q, revision.id), (marked) =>
							andThen(newUnitRowsFor(q, revision.id), (fresh) =>
								andThen(unmarkedUnitRowsFor(q, revision.id), (unmarked) =>
									andThen(revisionUpdateFor(q, revision.id), (summary) =>
										andThen(referenceRowsFor(q, revision.id), (referenceRows) =>
											andThen(overviewOf(q, revision.id), (overview) =>
												ok({
													sections,
													rows,
													marked,
													fresh,
													unmarked,
													summary,
													referenceRows,
													overview,
													sorting,
													assignments,
													shown: shownNow
												})
											)
										)
									)
								)
							)
						)
					)
				)
			);
		});
		if (!found.ok) return found;
		const { sections, rows, marked, summary } = found.value;
		const state = assignmentStateFromRows(diff, rows);
		if (!state.ok) return state;
		const reviewed = reviewedMarksFromRows(diff, marked);
		if (!reviewed.ok) return reviewed;
		const fresh = unitSetFromRows(diff, found.value.fresh, 'new changes');
		if (!fresh.ok) return fresh;
		const unmarked = unitSetFromRows(diff, found.value.unmarked, 'unmarked changes');
		if (!unmarked.ok) return unmarked;
		const references = referencesFromRows(diff, found.value.referenceRows);
		if (!references.ok) return references;
		return ok({
			summary: summaryOf(found.value.shown.report, found.value.shown.revision),
			report: found.value.shown.report,
			revision: found.value.shown.revision,
			snapshot,
			diff: diff,
			sections,
			references: references.value,
			overview: found.value.overview,
			frame: this.#frameVersions.frame(found.value.shown.report, revision.id, found.value.sorting),
			sorting: found.value.sorting,
			assignments: found.value.assignments,
			state: state.value,
			reviewed: reviewed.value,
			progress: reviewProgress(
				diff,
				state.value,
				reviewed.value,
				'sections',
				sections.map((s) => s.id)
			),
			leftOut: revision.leftOut,
			update:
				summary === undefined
					? undefined
					: { revision: revision.number, at: revision.takenAt, summary },
			fresh: fresh.value,
			unmarked: unmarked.value
		});
	}

	/** Compares stamps without reading the snapshot, assignments, parts or marks. */
	frameUnchanged(
		id: ReportId,
		version: RevisionNumber,
		frame: string
	): Result<boolean, ReportError> {
		return this.#db.read((q) => {
			const elsewhere = writesElsewhere(q);
			return map(
				asOf(q, id, version),
				({ report, revision }) =>
					this.#frameVersions.frame(
						report,
						revision.id,
						this.#sortingOf(revision.id, elsewhere)
					) === frame
			);
		});
	}

	#sortingOf(revision: RevisionId, elsewhere: number | undefined): string {
		return this.#frameVersions.stamp(revision, this.#sorting.countOf(revision), elsewhere);
	}

	#assignmentsOf(revision: RevisionId, elsewhere: number | undefined): string {
		return this.#frameVersions.stamp(revision, this.#sorting.assignmentsOf(revision), elsewhere);
	}

	/**
	 * Every report, open and closed, most recently active first. A report whose
	 * rows cannot be read is listed as damaged in its place, so one bad row
	 * never hides the others.
	 */
	list(): Result<readonly ListedReport[], ReportError> {
		return this.#db.read((q): Result<readonly ListedReport[], ReportError> => {
			const revisions = currentRevisions(q);
			const damaged = (id: ReportId | undefined, error: ReportError): ListedReport => {
				this.#logOnce(
					`A saved diff (${id ?? 'its id cannot be read'}) is damaged: ${JSON.stringify(error)}`
				);
				return { kind: 'damaged', id, problem: describeReportError(error) };
			};
			return ok(
				everyReport(q).map((row): ListedReport => {
					if (!row.ok) return damaged(row.error.id, row.error.error);
					const report = row.value;
					const revision = revisions.get(report.id);
					if (revision === undefined) {
						return damaged(report.id, { kind: 'ReportHasNoRevision', report: report.id });
					}
					if (!revision.ok) return damaged(report.id, revision.error);
					return { kind: 'report', ...summaryOf(report, revision.value) };
				})
			);
		});
	}

	/** One report as the list gives it, without reading the others. */
	summary(id: ReportId): Result<ReportSummary, ReportError> {
		return this.#db.read((q) =>
			andThen(current(q, id), ({ report, revision }) => ok(summaryOf(report, revision)))
		);
	}

	/**
	 * The agent's `upsert_sections`: creates, retitles, summarises, reorders and
	 * removes the sections of the current revision, and sets their
	 * cross-references, all or nothing (`applySectionChange`). Returns them in
	 * reading order. `seen` is the version the caller worked on; when the report
	 * has been updated since, nothing changes and the answer is `VersionOutOfDate`.
	 */
	async upsertSections(
		id: ReportId,
		seen: RevisionNumber,
		requests: readonly SectionRequest[],
		order?: readonly string[],
		remove?: readonly string[]
	): Promise<Result<readonly Section[], ReportError>> {
		const found = this.#db.read((q) => currentAsSeen(q, id, seen));
		if (!found.ok) return found;
		const content = await this.#contentOf(found.value.report, found.value.revision);
		if (!content.ok) return content;
		const { diff, revision } = content.value;
		return this.#db.write((q) =>
			andThen(currentAsSeen(q, id, seen), (now): Result<readonly Section[], ReportError> => {
				if (now.revision.id !== revision.id) {
					return err({ kind: 'RevisionChangedWhileSaving', report: id });
				}
				return andThen(sectionsOf(q, revision.id), (sections) =>
					andThen(referencesOf(q, revision.id, diff), (references) =>
						andThen(stateOf(q, revision, diff), ({ state }) => {
							const totals = coverage(diff, state).sections;
							const next = applySectionChange(
								{ sections, references },
								{
									sections: requests,
									...(order === undefined ? {} : { order }),
									...(remove === undefined ? {} : { remove })
								},
								{ diff, unitsIn: (section) => totals.get(section)?.units ?? NO_UNITS }
							);
							if (!next.ok) return err({ kind: 'SectionsRefused', problems: next.error });
							this.#sorting.replaceSections(q, revision.id, next.value.sections);
							replaceReferenceRows(q, revision.id, referenceRowsOf(next.value.references));
							touchReport(q, id, this.#clock.now());
							return ok(next.value.sections);
						})
					)
				);
			})
		);
	}

	/**
	 * The agent's `set_overview`: what the change does, in reading order, for
	 * the current revision, replacing the one it had. `seen` as for
	 * `upsertSections`.
	 */
	setOverview(
		id: ReportId,
		seen: RevisionNumber,
		markdown: AgentMarkdown
	): Result<AgentMarkdown, ReportError> {
		return this.#db.write((q) =>
			andThen(currentAsSeen(q, id, seen), ({ revision }): Result<AgentMarkdown, ReportError> => {
				storeOverview(q, revision.id, markdown);
				touchReport(q, id, this.#clock.now());
				this.#frameVersions.edited(revision.id);
				return ok(markdown);
			})
		);
	}

	/**
	 * The agent's `assign` (DESIGN 7.1) on the current revision: applies the
	 * items with core's rules, stores the result in one transaction, and returns
	 * core's outcome. Sections must exist (`upsertSections`) before lines go in them.
	 * `seen` is the version the caller worked on (see `markReviewed`).
	 */
	async assign(
		id: ReportId,
		seen: RevisionNumber,
		requests: readonly AssignRequest[]
	): Promise<Result<AssignOutcome, ReportError>> {
		return this.#changeState(id, seen, (q, revision, diff, state, marks) =>
			andThen(sectionsOf(q, revision.id), (sections) => {
				const outcome = assign(diff, state, requests, {
					knownSections: new Set(sections.map((s) => s.id))
				});
				const changed = changedAssignmentPaths(diff, state, outcome.state);
				this.#sorting.replaceAssignmentRows(
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
	 * `seen` is the version the reviewer was looking at: when the diff has been
	 * updated since, nothing is marked and the answer is `VersionOutOfDate`, so a
	 * tick sent from a page showing version 1 never marks version 2's new lines.
	 * A version newer than any the diff has is refused as `VersionNotFound`.
	 */
	async markReviewed(
		id: ReportId,
		seen: RevisionNumber,
		target: ReviewTarget,
		reviewed: boolean,
		view: ViewKind = 'sections',
		sorting?: string
	): Promise<Result<MarkOutcome, ReportError>> {
		return this.#changeState(id, seen, (q, revision, diff, state, marks) => {
			// BEGIN IMMEDIATE protects this comparison and the mark from other
			// writers. File ticks always cover the whole file at this revision.
			if (target.kind !== 'file' && sorting !== this.#sortingOf(revision.id, writesElsewhere(q))) {
				return err({ kind: 'SortingChanged' });
			}
			return andThen(markReviewed(diff, state, marks, target, reviewed, view), (marked) =>
				andThen(sectionsOf(q, revision.id), (sections) => {
					replaceReviewedRows(
						q,
						revision.id,
						marked.files,
						reviewedRowsOf(marked.marks, marked.files)
					);
					// A change the last update unmarked and the reviewer has marked again is
					// theirs now: unticking it later is not the update's doing, so the page no
					// longer says it was.
					if (reviewed) {
						const unmarked = forgetMarkedAgain(q, revision.id, diff, marked.marks, marked.files);
						if (!unmarked.ok) return unmarked;
					}
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
							units: marked.units,
							files: marked.files
						},
						state,
						marks: marked.marks
					});
				})
			);
		});
	}

	/**
	 * What one part shows when it is open: `group`'s part of the file at `path`
	 * in `view`, of the revision numbered `version`, with its hunks, the
	 * unchanged lines between them to open, and for a binary file its sizes.
	 * Reads only that file's rows, so opening a part of a large diff costs about
	 * what opening one of a small diff does. A file the version does not have is
	 * `FileNotInDiff`; a group it has no part in, `PartNotFound`.
	 */
	async readPart(
		id: ReportId,
		version: RevisionNumber,
		view: ViewKind,
		group: GroupKey,
		path: RepoPath,
		assignments?: string
	): Promise<Result<PartContent, ReportError>> {
		const shown = this.#db.read((q) => asOf(q, id, version));
		if (!shown.ok) return shown;
		const content = await this.#contentOf(shown.value.report, shown.value.revision);
		if (!content.ok) return content;
		const { snapshot, diff, revision } = content.value;
		const file = diff.byPath.get(path);
		if (file === undefined) return err({ kind: 'FileNotInDiff', path });
		const one: Diff = { files: [file], byPath: new Map([[path, file]]), unitCount: file.unitCount };
		const rows = this.#db.read(
			(
				q
			): Result<{ assigned: readonly AssignmentRow[]; fresh: readonly UnitRow[] }, ReportError> => {
				// Reading data_version pins the same SQLite snapshot as these rows.
				if (
					assignments !== undefined &&
					assignments !== this.#assignmentsOf(revision.id, writesElsewhere(q))
				) {
					return err({ kind: 'AssignmentsChanged' });
				}
				return andThen(assignmentRowsFor(q, revision.id, path), (assigned) =>
					andThen(newUnitRowsFor(q, revision.id, path), (fresh) => ok({ assigned, fresh }))
				);
			}
		);
		if (!rows.ok) return rows;
		const state = assignmentStateFromRows(one, rows.value.assigned);
		if (!state.ok) return state;
		const fresh = unitSetFromRows(one, rows.value.fresh, 'new changes');
		if (!fresh.ok) return fresh;
		const wanted = groupKeyId(group);
		if (!fileSlices(file, state.value, view).some((s) => groupKeyId(s.group) === wanted)) {
			return err({ kind: 'PartNotFound', path });
		}
		let headLines: LineCount | undefined;
		let sizes: PartContent['sizes'];
		const { old, new: now, content: kind } = file.file;
		switch (kind.kind) {
			case 'text':
				if (old !== undefined && now !== undefined) {
					const read = await readSnapshotLines(snapshot, 'new', path, FIRST_LINE, FIRST_LINE);
					if (read.ok) headLines = read.value.lineCount;
					else if (read.error.kind !== 'FileIsBinary') return read;
				}
				break;
			case 'binary': {
				// Each side by its own path, which a rename changes.
				const size = async (side: Side, there: FileVersion | undefined) => {
					if (there === undefined) return ok(undefined);
					const found = await snapshotEntry(snapshot, side, there.path);
					if (!found.ok) return found;
					return found.value.kind === 'file'
						? ok(found.value.size)
						: err({ kind: 'PathNotFound' as const, side, path: there.path });
				};
				const before = await size('old', old);
				if (!before.ok) return before;
				const after = await size('new', now);
				if (!after.ok) return after;
				sizes = { old: before.value, new: after.value };
				break;
			}
			case 'submodule':
				break;
		}
		let image: PartImage | undefined;
		const mayBeImage = (version: FileVersion | undefined): boolean =>
			version !== undefined && namedAsImage(version.path) && isPlainFile(version);
		if (kind.kind !== 'submodule' && (mayBeImage(old) || mayBeImage(now))) {
			const before = await imageSideOf(snapshot, 'old', old);
			if (!before.ok) return before;
			const after = await imageSideOf(snapshot, 'new', now);
			if (!after.ok) return after;
			const shown = (side: ImageSide | undefined): boolean =>
				side !== undefined && side.kind !== 'other';
			if (shown(before.value) || shown(after.value)) {
				// Every side the file has is an image: a binary file's header calls it one.
				const allImages = [before.value, after.value].every(
					(side) => side === undefined || side.kind !== 'other'
				);
				image = {
					old: before.value,
					new: after.value,
					sameBytes: old !== undefined && now !== undefined && old.blob === now.blob,
					change:
						kind.kind === 'binary' && allImages
							? describeFileChange(file.file, { withMode: false, image: true })
							: undefined
				};
			}
		}
		return ok({
			file,
			blocks: partBlocks(file, group, state.value, view, fresh.value, headLines),
			sizes,
			image
		});
	}

	/**
	 * One side of an image of the revision numbered `version`, to show as a
	 * picture: the file at `path` in its diff, read from the snapshot by the
	 * path it has on that side. A side the file does not have is
	 * `PathNotFound`; one that is not an image the page shows, `NotAnImage`;
	 * one larger than `MAX_IMAGE_SIZE`, `ImageTooLarge`, from its size alone.
	 */
	async readImage(
		id: ReportId,
		version: RevisionNumber,
		side: Side,
		path: RepoPath
	): Promise<Result<ImageFile, ReportError>> {
		const shown = this.#db.read((q) => asOf(q, id, version));
		if (!shown.ok) return shown;
		const content = await this.#contentOf(shown.value.report, shown.value.revision);
		if (!content.ok) return content;
		const { snapshot, diff } = content.value;
		const file = diff.byPath.get(path);
		if (file === undefined) return err({ kind: 'FileNotInDiff', path });
		if (file.file.content.kind === 'submodule') return err({ kind: 'NotAnImage', side, path });
		const there = file.file[side];
		if (there === undefined) return err({ kind: 'PathNotFound', side, path });
		if (!namedAsImage(there.path) || !isPlainFile(there)) {
			return err({ kind: 'NotAnImage', side, path });
		}
		const entry = await snapshotEntry(snapshot, side, there.path);
		if (!entry.ok) return entry;
		if (entry.value.kind !== 'file') return err({ kind: 'PathNotFound', side, path });
		if (entry.value.size > MAX_IMAGE_SIZE) {
			return err({ kind: 'ImageTooLarge', side, path, size: entry.value.size });
		}
		const read = await readSnapshotFile(snapshot, side, there.path);
		if (!read.ok) return read;
		const format = imageFormatOf(there.path, read.value.bytes);
		if (format === undefined) return err({ kind: 'NotAnImage', side, path });
		return ok({ format, bytes: read.value.bytes });
	}

	/**
	 * Searches the revision numbered `version` for `query` (DESIGN 8.3): each
	 * part of `view`, in reading order, with how many matches it has in its path
	 * and its hunks' lines (`core/search/diff-search.ts`); parts with none are
	 * left out. The answer is one entry per part, never one per match, so it is
	 * bounded by the size of the diff's frame; where each match is, the page
	 * finds in the part's lines when it has them. What a revision's parts read
	 * is worked out once and kept while its sorting stays the same.
	 */
	async searchDiff(
		id: ReportId,
		version: RevisionNumber,
		view: ViewKind,
		query: SearchText,
		options: DiffSearchOptions,
		assignments?: string
	): Promise<Result<readonly PartMatches[], ReportError>> {
		const shown = this.#db.read((q) => asOf(q, id, version));
		if (!shown.ok) return shown;
		const content = await this.#contentOf(shown.value.report, shown.value.revision);
		if (!content.ok) return content;
		const { diff, revision } = content.value;
		const indexed = this.#db.read((q): Result<SearchIndex, ReportError> => {
			const elsewhere = writesElsewhere(q);
			if (
				assignments !== undefined &&
				assignments !== this.#assignmentsOf(revision.id, elsewhere)
			) {
				return err({ kind: 'AssignmentsChanged' });
			}
			// The stamp, the cached index and its inputs belong to the same snapshot.
			const key = `${this.#sortingOf(revision.id, elsewhere)}\u0000${view}`;
			const cached = this.#searchIndexes.get(key);
			if (cached !== undefined) {
				this.#keepSearchIndex(key, cached);
				return ok(cached);
			}
			const sections = sectionsOf(q, revision.id);
			if (!sections.ok) return sections;
			const rows = assignmentRowsFor(q, revision.id);
			if (!rows.ok) return rows;
			const state = assignmentStateFromRows(diff, rows.value);
			if (!state.ok) return state;
			const frame = frameOf(
				diff,
				state.value,
				NO_PART_MARKS,
				view,
				sections.value.map((s) => s.id)
			);
			const parts = frame.groups.flatMap((g) => g.parts);
			const found = {
				parts: parts.map((p) => ({ group: p.group, path: p.file.file.path })),
				index: new DiffSearchIndex(
					parts.map((p) => ({
						path: shownRepoPath(p.file.file.path),
						lines: searchedLines(
							partBlocks(p.file, p.group, state.value, view, NO_PART_MARKS.fresh, undefined)
						)
					}))
				)
			};
			this.#keepSearchIndex(key, found);
			return ok(found);
		});
		if (!indexed.ok) return indexed;
		const found = indexed.value;
		const counts = found.index.counts(query, options);
		const matches: PartMatches[] = [];
		for (const [i, part] of found.parts.entries()) {
			const count = counts[i];
			if (count !== undefined && count > 0) matches.push({ ...part, matches: count });
		}
		return ok(matches);
	}

	/** Keeps a search index, as the most recently used, and lets the oldest go. */
	#keepSearchIndex(key: string, found: SearchIndex): void {
		this.#searchIndexes.delete(key);
		this.#searchIndexes.set(key, found);
		while (this.#searchIndexes.size > CACHED_SEARCH_INDEXES) {
			const oldest = this.#searchIndexes.keys().next();
			if (oldest.done === true) break;
			this.#searchIndexes.delete(oldest.value);
		}
	}

	#headPaths: { key: string; rows: ReturnType<typeof listSnapshotPaths> } | undefined;

	async searchFiles(
		id: ReportId,
		version: RevisionNumber,
		name: string
	): Promise<Result<FileMatch[], ReportError>> {
		const shown = this.#db.read((q) => asOf(q, id, version));
		if (!shown.ok) return shown;
		const snapshot = await this.#snapshotOf(shown.value.report, shown.value.revision);
		if (!snapshot.ok) return snapshot;
		const key = `${snapshot.value.store.id}/${snapshot.value.head}`;
		const cached =
			this.#headPaths?.key === key
				? this.#headPaths
				: { key, rows: listSnapshotPaths(snapshot.value, 'new') };
		this.#headPaths = cached;
		const [paths, diff] = await Promise.all([cached.rows, this.#diffOf(snapshot.value)]);
		if (!paths.ok) {
			if (this.#headPaths === cached) this.#headPaths = undefined;
			return paths;
		}
		if (!diff.ok) return diff;
		const query = name.trim().toLowerCase();
		const ranked: { match: FileMatch; score: number }[] = [];
		const include = (path: RepoPath, side: Side, changed: boolean): void => {
			const escaped = escapedRepoPath(path);
			const score = fileMatchScore(escaped.toLowerCase(), query);
			if (score !== Infinity) ranked.push({ match: { path: escaped, side, changed }, score });
		};
		for (const entry of paths.value) {
			include(entry.path, 'new', diff.value.byPath.get(entry.path)?.file.new !== undefined);
		}
		for (const { file } of diff.value.files) {
			if (file.status === 'deleted') include(file.path, 'old', true);
		}
		ranked.sort((a, b) => Number(b.match.changed) - Number(a.match.changed) || a.score - b.score);
		return ok(ranked.slice(0, FILE_MATCHES).map(({ match }) => match));
	}

	async readFile(
		id: ReportId,
		version: RevisionNumber,
		side: Side,
		path: RepoPath,
		first: LineNumber,
		last: LineNumber
	): Promise<Result<FileReaderView, ReportError>> {
		const shown = this.#db.read((q) => asOf(q, id, version));
		if (!shown.ok) return shown;
		const snapshot = await this.#snapshotOf(shown.value.report, shown.value.revision);
		if (!snapshot.ok) return snapshot;
		const [entry, diff] = await Promise.all([
			snapshotEntry(snapshot.value, side, path),
			this.#diffOf(snapshot.value)
		]);
		if (!entry.ok) return entry;
		if (!diff.ok) return diff;
		if (entry.value.kind === 'missing') return err({ kind: 'PathNotFound', side, path });
		if (entry.value.kind === 'folder') return err({ kind: 'PathIsDirectory', side, path });

		const direct = diff.value.byPath.get(path);
		const changed =
			direct?.file[side]?.path === path
				? direct
				: side === 'old'
					? diff.value.files.find(
							({ file }) => file.status === 'renamed' && file.old?.path === path
						)
					: undefined;
		const other = side === 'old' ? 'new' : 'old';
		let otherPath = changed?.file[other]?.path;
		if (changed === undefined) {
			const counterpart = await snapshotEntry(snapshot.value, other, path);
			if (!counterpart.ok) return counterpart;
			if (counterpart.value.kind === 'file' || counterpart.value.kind === 'submodule')
				otherPath = path;
		}
		const frame = {
			diffPath: changed === undefined ? null : escapedRepoPath(changed.file.path),
			otherPath: otherPath === undefined ? null : escapedRepoPath(otherPath),
			nonUtf8: false,
			lineCount: lineCountOf(0),
			lines: []
		};
		if (entry.value.kind === 'submodule') return ok({ ...frame, kind: 'submodule' });
		if (entry.value.size > MOST_FILE_BYTES) return ok({ ...frame, kind: 'large' });
		const file = await readSnapshotFile(snapshot.value, side, path);
		if (!file.ok) return file;
		if (file.value.binary) return ok({ ...frame, kind: 'binary' });
		const all = linesOf(file.value.bytes);
		return ok({
			...frame,
			kind: file.value.kind === 'symlink' ? 'symlink' : 'text',
			nonUtf8: !isUtf8(file.value.bytes),
			lineCount: lineCountOf(all.length),
			lines: all.slice(first - 1, last).map((text, i) => {
				const number = lineNumberOf(first + i);
				return { number, text, changed: changed?.changed[side].has(number) ?? false };
			})
		});
	}

	/**
	 * Lines `first` to `last` of one side of a file of the revision numbered
	 * `version`, as its snapshot holds them, for unchanged lines a part opens;
	 * the repository is not read.
	 */
	async readLines(
		id: ReportId,
		version: RevisionNumber,
		side: Side,
		path: RepoPath,
		first: LineNumber,
		last: LineNumber
	): Promise<Result<SnapshotLines, ReportError>> {
		const shown = this.#db.read((q) => asOf(q, id, version));
		if (!shown.ok) return shown;
		const snapshot = await this.#snapshotOf(shown.value.report, shown.value.revision);
		if (!snapshot.ok) return snapshot;
		return readSnapshotLines(snapshot.value, side, path, first, last);
	}

	/** Reads the one private draft, including comments anchored to earlier versions. */
	draftComments(id: ReportId): Result<readonly DraftComment[], ReportError> {
		return this.#db.read((q) => andThen(current(q, id), () => draftCommentsOf(q, id)));
	}

	/** Saves on the version the reviewer saw, at the exact path in that side's tree. */
	async addDraftComment(
		id: ReportId,
		seen: RevisionNumber,
		anchor: CommentAnchor,
		body: string
	): Promise<Result<DraftComment, ReportError>> {
		if (!isCommentBody(body)) return err({ kind: 'InvalidCommentBody' });
		if (anchor.last < anchor.first) return err({ kind: 'InvalidCommentRange' });
		const found = this.#db.read((q) => currentAsSeen(q, id, seen));
		if (!found.ok) return found;
		const content = await this.#contentOf(found.value.report, found.value.revision);
		if (!content.ok) return content;
		const { snapshot, diff, revision } = content.value;
		const file = diff.byPath.get(anchor.path);
		const side = file?.file[anchor.side];
		if (file?.file.content.kind !== 'text' || side === undefined) {
			return err({ kind: 'InvalidCommentRange' });
		}
		// Only the file's size is needed: the snapshot preserves the selected text.
		const read = await readSnapshotLines(snapshot, anchor.side, side.path, FIRST_LINE, FIRST_LINE);
		if (!read.ok) return read;
		if (anchor.last > read.value.lineCount) return err({ kind: 'InvalidCommentRange' });
		return this.#db.write((q) =>
			andThen(currentAsSeen(q, id, seen), (now): Result<DraftComment, ReportError> => {
				if (now.revision.id !== revision.id) {
					return err({ kind: 'RevisionChangedWhileSaving', report: id });
				}
				const at = this.#clock.now();
				return andThen(
					insertDraftComment(q, revision.id, { ...anchor, path: side.path }, body, at),
					(saved) => {
						touchReport(q, id, at);
						return ok(saved);
					}
				);
			})
		);
	}

	/**
	 * Changes the words of a comment of the draft, whichever version its lines
	 * are in. Like every change the reviewer makes, it is made only from a page
	 * that shows the Delve's current version (`seen`) and only while it is open,
	 * and only on the words the page read (`edits`, how many times they had been
	 * changed): otherwise nothing changes and the answer says why.
	 */
	editDraftComment(
		id: ReportId,
		seen: RevisionNumber,
		comment: DraftCommentId,
		edits: EditCount,
		body: string
	): Result<DraftComment, ReportError> {
		if (!isCommentBody(body)) return err({ kind: 'InvalidCommentBody' });
		return this.#db.write((q) =>
			andThen(currentAsSeen(q, id, seen), () =>
				andThen(draftCommentOf(q, id, comment), (found): Result<DraftComment, ReportError> => {
					if (found === undefined) return notInDraft(q, id, comment);
					if (found.edits !== edits) return err({ kind: 'CommentChanged' });
					if (found.body === body) return ok(found);
					const at = this.#clock.now();
					updateDraftComment(q, comment, body, at);
					touchReport(q, id, at);
					return andThen(draftCommentOf(q, id, comment), (changed) =>
						changed === undefined ? err({ kind: 'CommentNotFound' }) : ok(changed)
					);
				})
			)
		);
	}

	/** Deletes a comment of the draft, under the same rule as `editDraftComment`. */
	deleteDraftComment(
		id: ReportId,
		seen: RevisionNumber,
		comment: DraftCommentId,
		edits: EditCount
	): Result<DraftComment, ReportError> {
		return this.#db.write((q) =>
			andThen(currentAsSeen(q, id, seen), () =>
				andThen(draftCommentOf(q, id, comment), (found): Result<DraftComment, ReportError> => {
					if (found === undefined) return notInDraft(q, id, comment);
					if (found.edits !== edits) return err({ kind: 'CommentChanged' });
					deleteDraftComment(q, comment);
					touchReport(q, id, this.#clock.now());
					return ok(found);
				})
			)
		);
	}

	/** Reads the overall review of the one private draft. */
	overallReview(id: ReportId): Result<OverallReview, ReportError> {
		return this.#db.read((q) => andThen(current(q, id), () => draftSummaryOf(q, id)));
	}

	/**
	 * Replaces the words of the draft's overall review, exactly as typed, or
	 * empties it when they are only white space. It is the Delve's whole, not
	 * any version's, so it is saved from a page on any version, but only while
	 * the Delve is open and only on the words the page read (`edits`, how many
	 * times they had been changed): otherwise nothing changes and the answer
	 * says why.
	 */
	saveOverallReview(
		id: ReportId,
		edits: EditCount,
		body: string
	): Result<OverallReview, ReportError> {
		if (!isOverallReviewBody(body)) return err({ kind: 'InvalidOverallReview' });
		const words = storedOverallReview(body);
		return this.#db.write((q) =>
			andThen(currentOpen(q, id), () =>
				andThen(draftSummaryOf(q, id), (found): Result<OverallReview, ReportError> => {
					if (found.edits !== edits) return err({ kind: 'OverallReviewChanged' });
					if (found.body === words) return ok(found);
					const at = this.#clock.now();
					writeDraftSummary(q, id, words, at);
					touchReport(q, id, at);
					return draftSummaryOf(q, id);
				})
			)
		);
	}

	/**
	 * What finishing the draft now would hand over (DESIGN 8.6), for the page to
	 * show before the reviewer finishes it: the same text `finishReview` would
	 * record, numbered as the next review. Like the draft itself, only the
	 * reviewer's page reads it; no agent ever does.
	 */
	async previewReview(
		id: ReportId,
		seen: RevisionNumber
	): Promise<Result<ReviewPreview, ReportError>> {
		const prepared = await this.#prepareReview(id, seen);
		if (!prepared.ok) return prepared;
		const { found, diff, draft, quoted } = prepared.value;
		return this.#db.read((q) =>
			andThen(this.#reviewText(q, found, diff, draft, quoted), ({ number, text }) =>
				ok({ number, text, comments: draft.comments, overall: draft.overall })
			)
		);
	}

	/**
	 * Finishes the draft as the report's next review (DESIGN 6.3), against the
	 * version on the reviewer's page (`seen`), and only when the draft holds
	 * exactly the comments the page showed (`shown`, each with how many times
	 * its words had been changed) and the overall review it showed, so nothing
	 * written in another tab is handed over unseen. It records the text that is
	 * handed over, the overall review, the comments with the code they are on,
	 * and a copy of the reviewed marks, all in one transaction, and empties the
	 * draft: the next comment, or overall review, starts the next review. A
	 * review is never changed once it is finished.
	 */
	async finishReview(
		id: ReportId,
		seen: RevisionNumber,
		shown: ShownDraft
	): Promise<Result<JustFinished, ReportError>> {
		if (this.#posting.has(id)) {
			return err({
				kind: 'ReviewNotPosted',
				pullRequest: undefined,
				problem: { kind: 'being-posted' }
			});
		}
		const prepared = await this.#prepareReview(id, seen, shown);
		if (!prepared.ok) return prepared;
		const { found, diff, draft, quoted } = prepared.value;
		return this.#db.write((q) =>
			andThen(currentAsSeen(q, id, seen), (now): Result<JustFinished, ReportError> => {
				if (now.revision.id !== found.revision.id) {
					return err({ kind: 'RevisionChangedWhileSaving', report: id });
				}
				return andThen(draftOf(q, id), (draftNow): Result<JustFinished, ReportError> => {
					const may = finishable(q, id, draftNow, shown);
					if (!may.ok) return may;
					return andThen(
						this.#reviewText(q, found, diff, draft, quoted),
						({ number, text, progress, comments }): Result<JustFinished, ReportError> => {
							const at = this.#clock.now();
							insertReview(
								q,
								id,
								number,
								found.revision.id,
								at,
								progress,
								text,
								draft.overall.body
							);
							insertReviewComments(q, id, number, comments);
							copyReviewMarks(q, id, number, found.revision.id);
							for (const comment of draft.comments) deleteDraftComment(q, comment.id);
							if (draft.overall.body !== '') writeDraftSummary(q, id, '', at);
							touchReport(q, id, at);
							return andThen(reviewOf(q, id, number), (review) =>
								review === undefined
									? err({ kind: 'ReviewNotFound', number })
									: ok({ ...review, earlier: undefined })
							);
						}
					);
				});
			})
		);
	}

	/**
	 * Finishes the draft as `finishReview` does, and posts it to the Delve's
	 * pull request as one GitHub review (DESIGN 8.6): published as the kind
	 * chosen, or left a draft on GitHub. Its comments go on their lines where
	 * GitHub shows them, and the rest, with the overall review, in its text
	 * (`core/github/github-review.ts`); when GitHub refuses the lines, it is
	 * posted again with every comment in its text.
	 *
	 * The order keeps it from being lost or posted twice. The draft is checked
	 * as the page showed it, and the pull request is asked whether it is still
	 * open. The review's number is noted as being posted, then it is sent, and
	 * only once GitHub has made it is it recorded, with where it was posted, in
	 * one transaction that empties the draft and forgets the note. When posting
	 * fails, nothing is finished and the draft stays. When it may have reached
	 * GitHub unanswered, or the daemon stopped before recording it, the note
	 * stays, and the next post of that number looks on GitHub for its mark
	 * (`reviewMarker`) first, and records the review found instead of posting.
	 * Only one post or finish of a Delve runs at a time.
	 */
	async postReview(
		id: ReportId,
		seen: RevisionNumber,
		shown: ShownDraft,
		posting: GitHubPosting
	): Promise<Result<JustFinished, ReportError>> {
		if (this.#posting.has(id)) {
			return err({
				kind: 'ReviewNotPosted',
				pullRequest: undefined,
				problem: { kind: 'being-posted' }
			});
		}
		this.#posting.add(id);
		try {
			return await this.#post(id, seen, shown, posting);
		} finally {
			this.#posting.delete(id);
		}
	}

	async #post(
		id: ReportId,
		seen: RevisionNumber,
		shown: ShownDraft,
		posting: GitHubPosting
	): Promise<Result<JustFinished, ReportError>> {
		const prepared = await this.#prepareReview(id, seen, shown);
		if (!prepared.ok) return prepared;
		const { found, diff, draft, quoted } = prepared.value;
		const { source } = found.report;
		if (source.kind !== 'github') return err({ kind: 'NotAPullRequest' });
		const pullRequest = source.pullRequest;
		const refused = (problem: ReviewPostProblem): Result<never, ReportError> => {
			if (problem.kind === 'rate-limited') this.#noteRateLimit(problem.limit, this.#clock.now());
			return err({ kind: 'ReviewNotPosted', pullRequest, problem });
		};
		const commit = found.revision.headCommit;
		if (commit === undefined) return refused({ kind: 'no-commit' });
		const limited = await this.#rateLimited(pullRequest.repository.host);
		if (limited !== undefined) return refused({ kind: 'rate-limited', limit: limited });
		const asked = await readPullRequest(this.#github, pullRequest, this.#clock.now());
		if (!asked.read.ok) return refused(problemOf(asked.read.error));
		if (asked.read.value.kind === 'read' && asked.read.value.details.state !== 'open') {
			return refused({ kind: 'closed', merged: asked.read.value.details.state === 'merged' });
		}
		const text = this.#db.read((q) => this.#reviewText(q, found, diff, draft, quoted));
		if (!text.ok) return text;
		const { number } = text.value;
		const review = (allInText: boolean): GitHubReviewDraft =>
			gitHubReview({
				report: id,
				number,
				diff,
				version: found.revision.number,
				overall: draft.overall.body,
				comments: text.value.comments.map((r) => r.comment),
				allInText
			});
		const noted = this.#db.read((q) => reviewBeingPosted(q, id));
		if (!noted.ok) return noted;
		if (noted.value?.number === number) {
			const before = await findReview(
				this.#github,
				pullRequest,
				reviewMarker(id, number),
				this.#clock.now()
			);
			if (!before.ok) return refused(before.error);
			if (before.value !== undefined) {
				return this.#recordPosted(id, seen, pullRequest, before.value, true);
			}
		}
		const first = review(false);
		const edits = new Map(draft.comments.map((c) => [c.id, c.edits]));
		const note = this.#db.write((q): Result<undefined, ReportError> => {
			notePosting(
				q,
				id,
				{
					number,
					revision: found.revision.id,
					text: text.value.text,
					progress: text.value.progress,
					overall: draft.overall.body,
					overallEdits: draft.overall.edits,
					postedAs: postedAs(posting),
					allInText: false,
					inText: first.inText,
					comments: text.value.comments.map((r) => ({
						...r,
						edits: edits.get(r.draft) ?? NO_EDITS
					}))
				},
				this.#clock.now()
			);
			return ok(undefined);
		});
		if (!note.ok) return note;
		const sent = await this.#send(id, pullRequest, commit, posting, first, () => review(true));
		if (!sent.ok) {
			if (surelyNotPosted(sent.error)) {
				this.#db.write((q): Result<undefined, ReportError> => {
					forgetPosting(q, id);
					return ok(undefined);
				});
			}
			return refused(sent.error.kind === 'lines-refused' ? { kind: 'refused' } : sent.error);
		}
		return this.#recordPosted(id, seen, pullRequest, sent.value, false);
	}

	/**
	 * Records the review noted as being posted, which GitHub made as `made`,
	 * as the Delve's next review, exactly as it was sent: its text, its
	 * comments and marks, and how many comments went in its text, with what
	 * it is on GitHub taken from GitHub's own answer. What was sent leaves the
	 * draft; a comment added since, or one or an overall review whose words
	 * were changed since, stays in it, and the outcome says so.
	 */
	#recordPosted(
		id: ReportId,
		seen: RevisionNumber,
		pullRequest: PullRequestRef,
		made: GitHubReviewFound,
		earlier: boolean
	): Result<JustFinished, ReportError> {
		return this.#db.write((q) =>
			andThen(currentAsSeen(q, id, seen), (): Result<JustFinished, ReportError> =>
				andThen(reviewBeingPosted(q, id), (note): Result<JustFinished, ReportError> => {
					if (note === undefined) {
						return err({
							kind: 'StoredRowInvalid',
							table: 'github_review_posts',
							detail: 'the review being posted was not noted'
						});
					}
					return andThen(draftOf(q, id), (draftNow): Result<JustFinished, ReportError> => {
						const at = this.#clock.now();
						const { number } = note;
						const as = made.postedAs ?? note.postedAs;
						insertReview(q, id, number, note.revision, at, note.progress, note.text, note.overall);
						copyNotedReview(q, id, number);
						insertDelivery(q, id, number, made.id, {
							postedAs: as,
							address: gitHubReviewAddress(pullRequest, made.id, as === 'draft'),
							inText: note.inText,
							at
						});
						forgetPosting(q, id);
						const sent = new Map(note.comments.map((c) => [c.draft, c.edits]));
						let kept = false;
						for (const comment of draftNow.comments) {
							const edits = sent.get(comment.id);
							if (edits === comment.edits) {
								deleteDraftComment(q, comment.id);
								continue;
							}
							kept = true;
							// Its words were changed since they were sent: those stay, as a new comment.
							if (edits !== undefined) renumberDraftComment(q, comment.id);
						}
						if (draftNow.overall.edits === note.overallEdits) {
							if (note.overall !== '') writeDraftSummary(q, id, '', at);
						} else if (isWritten(draftNow.overall.body)) kept = true;
						touchReport(q, id, at);
						return andThen(reviewOf(q, id, number), (finished) =>
							finished === undefined
								? err({ kind: 'ReviewNotFound', number })
								: ok({ ...finished, earlier: earlier ? { draftKept: kept } : undefined })
						);
					});
				})
			)
		);
	}

	/**
	 * Sends the review to GitHub, its comments on their lines, and again with
	 * every comment in its text when GitHub refuses the lines, noting first
	 * that the review sent then has them all in its text.
	 */
	async #send(
		id: ReportId,
		pullRequest: PullRequestRef,
		commit: CommitId,
		posting: GitHubPosting,
		first: GitHubReviewDraft,
		allInText: () => GitHubReviewDraft
	): Promise<Result<GitHubReviewFound, ReviewPostProblem>> {
		const kind = posting.draft ? undefined : posting.kind;
		const sent = await postReview(
			this.#github,
			pullRequest,
			{ commit, kind, body: first.body, comments: first.comments },
			this.#clock.now()
		);
		if (sent.ok) return sent;
		if (sent.error.kind !== 'lines-refused' || first.comments.length === 0) return sent;
		const again = allInText();
		this.#db.write((q): Result<undefined, ReportError> => {
			noteAllInText(q, id, again.inText);
			return ok(undefined);
		});
		return postReview(
			this.#github,
			pullRequest,
			{ commit, kind, body: again.body, comments: [] },
			this.#clock.now()
		);
	}

	/** The report's finished reviews, oldest first. */
	reviews(id: ReportId): Result<readonly FinishedReview[], ReportError> {
		return this.#db.read((q) => andThen(current(q, id), () => reviewsOf(q, id)));
	}

	/**
	 * One finished review of the report, by number, or its latest; undefined
	 * when it has none yet. A draft is never returned.
	 */
	review(id: ReportId, number?: ReviewNumber): Result<FinishedReview | undefined, ReportError> {
		return this.#db.read((q) =>
			andThen(current(q, id), () =>
				andThen(
					reviewOf(q, id, number),
					(review): Result<FinishedReview | undefined, ReportError> =>
						review === undefined && number !== undefined
							? err({ kind: 'ReviewNotFound', number })
							: ok(review)
				)
			)
		);
	}

	/**
	 * The draft, on the version the page saw, with the code each comment is on.
	 * Given the comments a page showed, only when it may be finished as shown.
	 */
	async #prepareReview(
		id: ReportId,
		seen: RevisionNumber,
		shown?: ShownDraft
	): Promise<Result<PreparedReview, ReportError>> {
		const read = this.#db.read((q): Result<{ found: Current; draft: Draft }, ReportError> =>
			andThen(currentAsSeen(q, id, seen), (found) =>
				andThen(draftOf(q, id), (draft): Result<{ found: Current; draft: Draft }, ReportError> => {
					if (shown === undefined) {
						return anythingToFinish(draft)
							? ok({ found, draft })
							: err({ kind: 'NothingToFinish' });
					}
					return andThen(finishable(q, id, draft, shown), () => ok({ found, draft }));
				})
			)
		);
		if (!read.ok) return read;
		const { found, draft } = read.value;
		const content = await this.#contentOf(found.report, found.revision);
		if (!content.ok) return content;
		const quoted: (readonly LineText[])[] = [];
		for (const comment of draft.comments) {
			const { side, path, first, last } = comment.anchor;
			const upTo = lineNumberOf(Math.min(last, first + MAX_QUOTED_LINES - 1));
			const lines = await this.readLines(id, comment.version, side, path, first, upTo);
			if (!lines.ok) return lines;
			quoted.push(lines.value.lines.map((l) => l.text));
		}
		return ok({
			found: { report: found.report, revision: content.value.revision },
			diff: content.value.diff,
			draft,
			quoted
		});
	}

	/**
	 * The text of the next review, from the draft and the revision's sorting and
	 * marks as the database holds them now, read in the caller's transaction.
	 */
	#reviewText(
		q: Queries,
		found: Current,
		diff: Diff,
		draft: Draft,
		quoted: readonly (readonly LineText[])[]
	): Result<ReviewText, ReportError> {
		const { report, revision } = found;
		return andThen(latestReviewNumber(q, report.id), (latest) =>
			andThen(stateOf(q, revision, diff), ({ state, marks }) =>
				andThen(sectionsOf(q, revision.id), (sections): Result<ReviewText, ReportError> => {
					const number = nextReviewNumber(latest);
					const progress = unitProgressOf(
						reviewProgress(
							diff,
							state,
							marks,
							'sections',
							sections.map((s) => s.id)
						)
					);
					return andThen(frozenComments(q, report.id, draft.comments, quoted), (rows) =>
						ok({
							number,
							progress,
							comments: rows,
							text: renderReviewExport({
								number,
								report: report.id,
								title: reportTitle(report.source),
								repository: repositoryLabel(report.repositoryPath),
								version: revision.number,
								headCommit: revision.headCommit,
								overall: draft.overall.body,
								comments: rows.map((r) => r.comment),
								notReviewed: notReviewed(diff, state, marks, sections),
								progress
							})
						})
					);
				})
			)
		);
	}

	/**
	 * The colours of lines of the file at `path` in the revision numbered
	 * `version`, by language (DESIGN 8.3): for each side, the lines asked for,
	 * coloured as part of the whole file, or why that side is shown plain. Each
	 * side is read at its own path, so a renamed or copied file's old side is
	 * its old file, in that file's language. A side the file does not have, or
	 * that no line was asked of, is undefined; a path not in the diff is
	 * `FileNotInDiff` unless the caller asks for the exact path on both sides.
	 */
	async readColours(
		id: ReportId,
		version: RevisionNumber,
		path: RepoPath,
		wanted: Readonly<Record<Side, readonly LineSpan[]>>,
		exact = false
	): Promise<Result<PartColours, ReportError>> {
		const shown = this.#db.read((q) => asOf(q, id, version));
		if (!shown.ok) return shown;
		const content = await this.#contentOf(shown.value.report, shown.value.revision);
		if (!content.ok) return content;
		const { snapshot, diff } = content.value;
		const inDiff = diff.byPath.get(path);
		if (!exact && inDiff === undefined) return err({ kind: 'FileNotInDiff', path });
		const side = async (which: Side): Promise<Result<SideColours | undefined, ReportError>> => {
			const spans = wanted[which];
			const at = exact ? path : inDiff?.file[which]?.path;
			if (spans.length === 0 || at === undefined) return ok(undefined);
			if (exact) {
				const entry = await snapshotEntry(snapshot, which, at);
				if (!entry.ok) return entry;
				if (entry.value.kind !== 'file') return ok(undefined);
				if (entry.value.size > MOST_BYTES_TO_COLOUR) return ok({ kind: 'plain', reason: 'large' });
			}
			const file = await readSnapshotFile(snapshot, which, at);
			if (!file.ok) return file.error.kind === 'PathNotFound' ? ok(undefined) : file;
			if (exact && file.value.kind === 'symlink') return ok(undefined);
			if (file.value.binary) return ok({ kind: 'plain', reason: 'binary' });
			const lines = linesOf(file.value.bytes);
			const colours = await this.#colours.colours(
				file.value.blob,
				languageOf(at, lines[0]),
				file.value.size,
				lines
			);
			if (colours.kind === 'plain') return ok(colours);
			const found: { readonly number: LineNumber; readonly runs: readonly ColourRun[] }[] = [];
			for (const span of spans) {
				for (let n: number = span.first; n <= span.last; n += 1) {
					const runs = colours.lines.line(lineNumberOf(n));
					if (runs === undefined) break;
					if (runs.length > 0) found.push({ number: lineNumberOf(n), runs });
				}
			}
			return ok({ kind: 'coloured', lines: found });
		};
		const old = await side('old');
		if (!old.ok) return old;
		const now = await side('new');
		if (!now.ok) return now;
		return ok({ old: old.value, new: now.value });
	}

	/**
	 * How the person likes diffs shown. A setting that cannot be read is logged
	 * once and has its default, so a damaged row never stands between the
	 * person and their diffs; changing the setting stores it again.
	 */
	settings(): ViewSettings {
		const read = this.#db.read((q) => readSettings(q));
		if (read.ok) return read.value;
		this.#logOnce(`Could not read the settings: ${JSON.stringify(read.error)}`);
		return DEFAULT_SETTINGS;
	}

	/** Changes one setting, and gives the settings as they now are. */
	changeSetting(change: SettingChange): Result<ViewSettings, ReportError> {
		const written = this.#db.write((q): Result<void, ReportError> => {
			writeSetting(q, change);
			return ok(undefined);
		});
		if (!written.ok) return written;
		return ok(this.settings());
	}

	/** Closes a report at the reviewer's request. Closing a closed report changes nothing. */
	closeReport(id: ReportId): Result<ReportSummary, ReportError> {
		const closed = this.#db.write((q) =>
			andThen(current(q, id), ({ report, revision }): Result<ReportSummary, ReportError> => {
				if (report.state.kind === 'closed') return ok(summaryOf(report, revision));
				const state: ReportState = { kind: 'closed', reason: 'reviewer' };
				const now = this.#clock.now();
				setReportState(q, id, state, now);
				return ok(summaryOf({ ...report, state, lastActivityAt: now }, revision));
			})
		);
		// A closed report is not followed, so a snapshot kept for its update is not needed.
		if (closed.ok) void this.#forget(id);
		return closed;
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
		let stores: readonly StoreId[] = [];
		let pullRequest: PullRequestRef | undefined;
		const removed = this.#db.write((q): Result<readonly StoredSnapshot[], ReportError> => {
			if (!reportExists(q, id)) return err({ kind: 'ReportNotFound', report: id });
			// A damaged report's source cannot be read: its downloads are left to tidying.
			const report = reportById(q, id);
			if (report.ok && report.value?.source.kind === 'github') {
				pullRequest = report.value.source.pullRequest;
			}
			const snapshots = snapshotsOfReport(q, id);
			stores = [...new Set(snapshots.map((s) => s.store))];
			deleteReportRow(q, id);
			return ok(snapshots.filter((s) => !snapshotInUse(q, s)));
		});
		if (!removed.ok) return removed;
		await this.#forget(id);
		// A pull request's downloads go with its Delve, collected with its
		// snapshots; only its own, since another pull request's may be a moment
		// old, for a Delve not recorded yet, and tidying sees to the rest.
		const key = pullRequest === undefined ? undefined : fetchKey(pullRequest);
		for (const storeId of key === undefined ? [] : stores) {
			const store = await openStore(this.#dataDirectory, storeId);
			if (store.ok) await forgetPullRequestFetches(store.value, (kept) => kept.key === key);
		}
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
	async checkForChanges(
		id: ReportId,
		seen?: RevisionNumber
	): Promise<Result<ChangeCheck, ReportError>> {
		const found = this.#db.read((q) => current(q, id));
		if (!found.ok) return found;
		const { report, revision } = found.value;
		// A page showing an older revision must say so before anything else.
		if (seen !== undefined && seen !== revision.number) {
			return ok({ kind: 'updated', revision: revision.number });
		}
		if (report.state.kind === 'closed') return ok({ kind: 'report-closed' });
		// Several pages, or one that got the focus and became visible at once, share one look.
		const key = `${report.id}/${revision.id}`;
		const under = this.#checking.get(key);
		if (under !== undefined) return under;
		const checking = (async (): Promise<Result<SourceCheck, ReportError>> => {
			const repo = await this.#repositoryOf(report);
			return repo.ok ? this.#check(found.value, repo.value) : repo;
		})();
		this.#checking.set(key, checking);
		try {
			return await checking;
		} finally {
			this.#checking.delete(key);
		}
	}

	/**
	 * Brings an open report up to date with its source, when asked (DESIGN 6.2):
	 * takes a new snapshot, or uses the one `checkForChanges` took when it is
	 * still the one needed, and when its trees differ from the current
	 * revision's, makes the next revision with the sections, the sorting and the
	 * reviewed marks carried over, in one transaction. Makes nothing when the
	 * source has not changed, or has nothing left to review. A closed report is
	 * not updated. The repository is only read.
	 */
	async update(id: ReportId): Promise<Result<UpdateOutcome, ReportError>> {
		const found = this.#db.read((q) => currentOpen(q, id));
		if (!found.ok) return found;
		const repo = await this.#repositoryOf(found.value.report);
		if (!repo.ok) return repo;
		return this.#update(id, repo.value);
	}

	/**
	 * Removes snapshots no revision refers to that have gone unreferenced for
	 * longer than the store's grace period, such as one a crash left between
	 * taking a snapshot and recording its revision, then collects the store.
	 * Never one this service holds (`#held`): the snapshot a check keeps for the
	 * next update, or one an open, a check or an update is using. The daemon
	 * calls this now and then; it returns what it removed.
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
					for (const id of listed.value.map((s) => s.id)) {
						if (this.#held.has(heldKey(store.id, id))) used.add(id);
					}
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

	/**
	 * Tidies the stores now and then (DESIGN 9.1): removes the snapshots nothing
	 * refers to (`removeUnusedSnapshots`), and collects every store this service
	 * discarded a snapshot from since the last tidy, such as one a check for
	 * changes took and did not need, so their objects do not pile up until the
	 * daemon next starts. The daemon calls it from time to time; it returns the
	 * stores it collected.
	 */
	async tidyStores(): Promise<Result<readonly StoreId[], ReportError>> {
		const removed = await this.removeUnusedSnapshots();
		if (!removed.ok) return removed;
		const collected = new Set(removed.value.map((r) => r.store));
		// Downloads kept for a pull request that has no Delve, such as one whose
		// opening failed after its fetch, and those a stopped move left half kept,
		// once a fetch under way cannot be adding one.
		const stores = await listStores(this.#dataDirectory);
		if (!stores.ok) return stores;
		const before = Date.now() - GRACE_PERIOD;
		for (const store of stores.value) {
			const live = new Set(this.#pullRequestsIn(store.id).map(fetchKey));
			const stray = (kept: KeptFetch): boolean => !live.has(kept.key) && kept.writtenAt < before;
			// A download under way that a stopped daemon left, in a folder of its own.
			await removeStaleFolders(store.dir, 'diff-delver-incoming-');
			// The half kept first, while their `.keep` files still name their packs.
			await removeHalfKeptFetches(store, before);
			if ((await forgetPullRequestFetches(store, stray)) > 0) this.#discarded.add(store.id);
		}
		// Taken now: a snapshot discarded while this runs is collected next time.
		const due = [...this.#discarded].filter((id) => !collected.has(id));
		this.#discarded.clear();
		for (const [i, id] of due.entries()) {
			const store = await openStore(this.#dataDirectory, id);
			const done = store.ok
				? await collectGarbage(store.value)
				: store.error.kind === 'StoreNotFound'
					? ok(undefined)
					: store;
			if (!done.ok) {
				for (const left of due.slice(i)) this.#discarded.add(left);
				return done;
			}
			if (store.ok) collected.add(id);
		}
		return ok([...collected]);
	}

	// --- Inside -------------------------------------------------------------------

	/**
	 * The pull requests of the Delves whose snapshots are in `store`, whose
	 * downloads it keeps. One that cannot be read is left out, so its
	 * downloads may be forgotten, which costs only a longer download.
	 */
	#pullRequestsIn(store: StoreId): readonly PullRequestRef[] {
		const found = this.#db.read((q) =>
			ok(
				everyReport(q).flatMap((row) =>
					row.ok && row.value.store === store && row.value.source.kind === 'github'
						? [row.value.source.pullRequest]
						: []
				)
			)
		);
		return found.ok ? found.value : [];
	}

	/** Deletes a snapshot no revision will use, noting its store for the next tidy. */
	async #discard(store: Snapshot['store'], id: SnapshotId): Promise<void> {
		this.#discarded.add(store.id);
		await deleteSnapshot(store, id);
		this.#held.delete(heldKey(store.id, id));
	}

	/**
	 * Takes a snapshot of a source, held from tidying until a revision refers to
	 * it or it is discarded. A git source's goes into its repository's store; a
	 * pull request's into `store`, its Delve's own, which may be another clone's
	 * (`#pullRequestRepository`), so every version of the Delve is in one store.
	 */
	async #takeSnapshot(
		repo: LocalRepository,
		spec: SourceSpec,
		store: StoreId
	): Promise<Result<GitSnapshot, ReportError>> {
		let take: (id: SnapshotId) => Promise<Result<GitSnapshot, ReportError>>;
		let into = repo.storeId;
		if (spec.kind === 'pull-request') {
			// Of what GitHub said just before, which every caller has asked.
			const details = await this.#pullRequestDetails(spec.pullRequest, 'just-asked');
			if (!details.ok) return details;
			into = store;
			take = (id) =>
				snapshotPullRequest(this.#dataDirectory, repo, store, details.value, this.#github, id);
		} else {
			take = (id) => snapshotGitSource(this.#dataDirectory, repo, spec, id);
		}
		const id = this.#ids.snapshotId();
		this.#held.add(heldKey(into, id));
		const taken = await take(id);
		if (!taken.ok) this.#held.delete(heldKey(into, id));
		return taken;
	}

	/**
	 * What GitHub says of a pull request, asked as `asking` says (see
	 * `GitHubAsking`), with the tag of its last answer so that an unchanged
	 * pull request costs a signed-in person nothing. A refusal is kept too: one
	 * for too many requests until GitHub said to try again, for every caller
	 * and every pull request of its host, while the person is signed in or out
	 * as they were when it was refused (`#rateLimited`); any other for
	 * `PULL_REQUEST_CHECK_EVERY_MS`, for a page's checks of this pull request only.
	 */
	async #pullRequestDetails(
		ref: PullRequestRef,
		asking: GitHubAsking
	): Promise<Result<PullRequestDetails, ReportError>> {
		const key = pullRequestIdentityParts(ref).join('/');
		const now = this.#clock.now();
		const kept = this.#pullRequests.get(key);
		if (asking === 'just-asked' && kept !== undefined) return ok(kept.details);
		if (asking === 'check' && kept !== undefined && now - kept.at < checkEvery(kept.signedIn)) {
			return ok(kept.details);
		}
		const limited = await this.#rateLimited(ref.repository.host);
		if (limited !== undefined) return err(limited);
		const refused = this.#pullRequestRefusals.get(key);
		if (
			asking === 'check' &&
			refused !== undefined &&
			timeBetween(refused.at, now) < refused.wait
		) {
			return err(refused.error);
		}
		const { signedIn, read } = await readPullRequest(this.#github, ref, now, kept?.etag);
		if (!read.ok) {
			const { error } = read;
			if (error.kind === 'GitHubRateLimited') this.#noteRateLimit(error, now);
			else
				this.#pullRequestRefusals.set(key, { error, at: now, wait: PULL_REQUEST_CHECK_EVERY_MS });
			return read;
		}
		this.#pullRequestRefusals.delete(key);
		if (read.value.kind === 'not-modified') {
			if (kept === undefined) {
				return err({ kind: 'GitHubAnswerUnreadable', host: ref.repository.host, status: 304 });
			}
			this.#pullRequests.set(key, { ...kept, at: now, signedIn });
			return ok(kept.details);
		}
		const { details, etag } = read.value;
		this.#pullRequests.set(key, { at: now, details, etag, signedIn });
		return ok(details);
	}

	/**
	 * GitHub's refusal for too many requests to `host` that still stands for
	 * the person as they are now, signed in or out, with how long is left; or
	 * undefined, when GitHub may be asked. Whether they are signed in is asked
	 * only while a refusal stands, so that signing in, or out, asks GitHub
	 * again at once.
	 */
	async #rateLimited(host: GitHubHost): Promise<GitHubRateLimited | undefined> {
		const now = this.#clock.now();
		let standing = false;
		for (const signedIn of [false, true]) {
			const key = rateLimitKey(host, signedIn);
			const limit = this.#rateLimits.get(key);
			if (limit === undefined) continue;
			if (timeBetween(limit.at, now) < limit.wait) standing = true;
			else this.#rateLimits.delete(key);
		}
		if (!standing) return undefined;
		const signedIn = (await this.#github.token(host)) !== undefined;
		const limit = this.#rateLimits.get(rateLimitKey(host, signedIn));
		if (limit === undefined) return undefined;
		const left = limit.wait - timeBetween(limit.at, now);
		return { ...limit.error, waitSeconds: Math.ceil(left / 1000) };
	}

	/** Keeps a refusal for too many requests until GitHub said to try again, or a minute. */
	#noteRateLimit(error: GitHubApiError, now: Timestamp): void {
		if (error.kind !== 'GitHubRateLimited') return;
		this.#rateLimits.set(rateLimitKey(error.host, error.signedIn), {
			error,
			at: now,
			wait: (error.waitSeconds ?? RATE_LIMIT_WAIT_SECONDS) * 1000
		});
	}

	/** The source of a new report of `spec`, with what it is named by. */
	async #reportSourceOf(repo: LocalRepository, spec: SourceSpec): Promise<Report['source']> {
		if (spec.kind !== 'pull-request') {
			return { kind: 'git', spec, run: await readCommitRun(repo, spec) };
		}
		const kept = this.#pullRequests.get(pullRequestIdentityParts(spec.pullRequest).join('/'));
		return {
			kind: 'github',
			pullRequest: spec.pullRequest,
			title: kept?.details.title ?? pullRequestTitleOf(''),
			description: kept?.details.description
		};
	}

	/**
	 * A look at the report's source before any snapshot: its fingerprint now,
	 * or, for a pull request that has been merged or closed, that nothing is
	 * left. A pull request is asked of GitHub as `asking` says; a new title or
	 * description is kept.
	 */
	async #lookAt(
		report: Report,
		repo: LocalRepository,
		asking: GitHubAsking
	): Promise<Result<Look, ReportError>> {
		const { source } = report;
		if (source.kind === 'git') {
			const fingerprint = await sourceIdentity(repo, source.spec);
			return fingerprint.ok
				? ok({ kind: 'fingerprint', fingerprint: fingerprint.value })
				: fingerprint;
		}
		const details = await this.#pullRequestDetails(source.pullRequest, asking);
		if (!details.ok) return details;
		const { title, description, state } = details.value;
		if (title !== source.title || description !== source.description) {
			const kept = this.#db.write((q) => {
				writePullRequestText(q, report.id, { title, description });
				return ok(undefined);
			});
			if (!kept.ok) return kept;
		}
		if (state !== 'open')
			return ok({ kind: 'nothing-left', ...pullRequestNothingLeft(source.pullRequest, state) });
		return ok({ kind: 'fingerprint', fingerprint: pullRequestFingerprint(details.value) });
	}

	#logOnce(line: string): void {
		if (this.#logged.has(line)) return;
		this.#logged.add(line);
		this.#log(line);
	}

	async #openIn(
		repo: LocalRepository,
		spec: SourceSpec
	): Promise<Result<OpenOutcome, ReportError>> {
		const identity =
			spec.kind === 'pull-request'
				? pullRequestReportIdentity(spec.pullRequest)
				: gitReportIdentity({ store: repo.storeId, spec, worktree: worktreeOf(repo) });
		const existing = this.#db.read((q) =>
			andThen(openReportFor(q, identity), (report) =>
				report === undefined ? ok(undefined) : current(q, report.id)
			)
		);
		if (!existing.ok) return existing;
		if (existing.value === undefined) return this.#create(repo, spec, identity, undefined);
		const { report, revision } = existing.value;
		const readable = await this.#snapshotOf(report, revision);
		if (readable.ok) {
			if (report.source.kind === 'git') return this.#resume(existing.value, repo);
			const own = await this.#pullRequestRepository(report, repo);
			return own.ok ? this.#resume(own.value.found ?? existing.value, own.value.repo) : own;
		}
		if (readable.error.kind !== 'SnapshotGone') return readable;
		// Its snapshot is gone, so it can never be shown: close it and start again.
		const closed = this.#db.write((q) => {
			setReportState(q, report.id, { kind: 'closed', reason: 'snapshot-gone' }, this.#clock.now());
			return ok(undefined);
		});
		if (!closed.ok) return closed;
		await this.#forget(report.id);
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
	 * Resumes the source's open report, bringing it up to date first, since
	 * opening a source is a request to see its files as they are now (DESIGN
	 * 6.2); when its source has nothing left to review, closes it instead
	 * (DESIGN 6.1: it closes when its source is next opened and has nothing to
	 * review) and says so.
	 */
	async #resume(found: Current, repo: LocalRepository): Promise<Result<OpenOutcome, ReportError>> {
		const updated = await this.#update(found.report.id, repo);
		if (!updated.ok) return updated;
		switch (updated.value.kind) {
			case 'unchanged':
				return ok({ kind: 'resumed', report: updated.value.report, update: undefined });
			case 'updated':
				return ok({
					kind: 'resumed',
					report: updated.value.report,
					update: updated.value.summary
				});
			case 'nothing-left': {
				const { next } = updated.value;
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
				await this.#forget(found.report.id);
				return ok({
					kind: 'nothing-to-review',
					source: reportTitle(found.report.source),
					reason:
						found.report.source.kind === 'git'
							? describeNothingToReview(found.report.source.spec)
							: updated.value.reason,
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
		spec: SourceSpec,
		identity: ReportIdentity,
		replacing: ReportId | undefined
	): Promise<Result<OpenOutcome, ReportError>> {
		if (spec.kind === 'pull-request') {
			// Asked now, since opening it is a request to see it as it is.
			const details = await this.#pullRequestDetails(spec.pullRequest, 'person');
			if (!details.ok) return details;
			const { state, title } = details.value;
			if (state !== 'open') {
				return ok({
					kind: 'nothing-to-review',
					source: describePullRequest(spec.pullRequest, title),
					reason: describePullRequestNothingToReview(state),
					leftOut: [],
					closed: replacing,
					next: undefined
				});
			}
		}
		const taken = await this.#takeSnapshot(repo, spec, repo.storeId);
		if (!taken.ok) return taken;
		const { snapshot } = taken.value;
		const discard = async <T>(result: Result<T, ReportError>): Promise<Result<T, ReportError>> => {
			await this.#discard(snapshot.store, snapshot.id);
			return result;
		};
		const diff = await this.#diffOf(snapshot);
		if (!diff.ok) return discard(diff);
		// A run of commits is named by its commits, read now and kept with the report.
		const source = await this.#reportSourceOf(repo, spec);
		if (diff.value.files.length === 0) {
			return discard(
				ok({
					kind: 'nothing-to-review',
					source: reportTitle(source),
					reason:
						spec.kind === 'pull-request'
							? describePullRequestNothingToReview('open')
							: describeNothingToReview(spec),
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
		const binary = await binaryOf(snapshot, diff.value);
		if (!binary.ok) return discard(binary);
		const now = this.#clock.now();
		const report: Report = {
			id: this.#ids.reportId(),
			identity,
			source,
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
			size: diffSizeOf(diff.value, sorted.state),
			binary: binary.value,
			progress: unitProgressOf(reviewProgress(diff.value, sorted.state, NO_MARKS, 'sections'))
		};
		const written = this.#db.write((q) =>
			andThen(openReportFor(q, identity), (raced): Result<ReportId | undefined, ReportError> => {
				// Another copy of diff delver opened the same source first: use its report.
				if (raced !== undefined) return ok(raced.id);
				insertReport(q, report);
				insertRevision(q, revision);
				this.#sorting.replaceAssignmentRows(
					q,
					revision.id,
					'all',
					assignmentRowsOf(diff.value, sorted.state)
				);
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
		// Its revision refers to it now.
		this.#held.delete(heldKey(snapshot.store.id, snapshot.id));
		return ok({
			kind: 'created',
			report: summaryOf(report, revision),
			autoIgnored: sorted.ignored,
			closed: replacing
		});
	}

	/**
	 * The report's repository, if it is still the one the report was opened in:
	 * for a git source, the same repository; for a pull request, still a clone
	 * of its repository on GitHub.
	 */
	async #repositoryOf(report: Report): Promise<Result<LocalRepository, ReportError>> {
		const repo = await locateRepository(report.repositoryPath, this.#repository);
		if (!repo.ok) return repo;
		const same =
			report.source.kind === 'github'
				? (await cloneOf(repo.value, report.source.pullRequest)).ok
				: repo.value.storeId === report.store;
		return same ? repo : err({ kind: 'RepositoryReplaced', path: report.repositoryPath });
	}

	/**
	 * The clone a pull request's Delve is updated through when it is opened from
	 * `opened`: its own repository while that is there, so the page's checks and
	 * every update use the same one; or else `opened`, which it then moves to,
	 * with `found` its report as moved. The snapshots stay in the Delve's store
	 * either way, so what was sorted and ticked is carried over.
	 */
	async #pullRequestRepository(
		report: Report,
		opened: LocalRepository
	): Promise<Result<{ repo: LocalRepository; found: Current | undefined }, ReportError>> {
		const own = await this.#repositoryOf(report);
		if (own.ok) return ok({ repo: own.value, found: undefined });
		const moved = this.#db.write((q) => {
			setReportRepository(q, report.id, {
				name: repositoryNameOf(opened.commonDir),
				path: worktreeOf(opened)
			});
			return current(q, report.id);
		});
		return moved.ok ? ok({ repo: opened, found: moved.value }) : moved;
	}

	async #check(found: Current, repo: LocalRepository): Promise<Result<SourceCheck, ReportError>> {
		const { report, revision } = found;
		const look = await this.#lookAt(report, repo, 'check');
		if (!look.ok) return look;
		if (look.value.kind === 'nothing-left') return ok(look.value);
		const { fingerprint } = look.value;
		if (fingerprint === revision.fingerprint) return ok({ kind: 'unchanged' });
		const remembered = this.#checks.get(report.id);
		if (remembered?.revision === revision.id && remembered.fingerprint === fingerprint) {
			return ok(remembered.outcome);
		}
		const probe = await this.#probe(found, repo, fingerprint);
		if (!probe.ok) return probe;
		const remember = async (
			outcome: SourceCheck,
			prepared: Prepared | undefined
		): Promise<Result<SourceCheck, ReportError>> => {
			await this.#remember(report.id, {
				revision: revision.id,
				fingerprint,
				outcome,
				prepared
			});
			return ok(outcome);
		};
		switch (probe.value.kind) {
			case 'unchanged':
				return remember({ kind: 'unchanged' }, undefined);
			case 'nothing-left':
				return remember(probe.value, undefined);
			case 'changed': {
				const { prepared } = probe.value;
				const files = await this.#filesChanged(found, prepared);
				if (!files.ok) {
					await this.#discard(prepared.taken.snapshot.store, prepared.taken.snapshot.id);
					return files;
				}
				const pullRequest: PullRequestChange | undefined =
					report.source.kind === 'git'
						? undefined
						: prepared.taken.headCommit === revision.headCommit
							? 'base'
							: 'pushed';
				return remember(
					{
						kind: 'changed',
						files: files.value,
						...(pullRequest === undefined ? {} : { pullRequest })
					},
					prepared
				);
			}
		}
	}

	/**
	 * Looks at the source against the current revision, with a new snapshot or
	 * the one the last check kept when it is still the one needed (which it
	 * then hands over): unchanged, nothing left to review, or changed, with what
	 * carrying over needs. A snapshot that is not handed over is deleted.
	 */
	async #probe(
		found: Current,
		repo: LocalRepository,
		fingerprint: SourceIdentity
	): Promise<Result<Probe, ReportError>> {
		const { report, revision } = found;
		const kept = await this.#keptProbe(report.id, revision.id, fingerprint);
		if (kept !== undefined) return ok({ kind: 'changed', prepared: kept });
		const spec = sourceSpecOf(report.source);
		const taken = await this.#takeSnapshot(repo, spec, report.store);
		if (!taken.ok) return taken;
		const { snapshot } = taken.value;
		const discard = async <T>(result: Result<T, ReportError>): Promise<Result<T, ReportError>> => {
			await this.#discard(snapshot.store, snapshot.id);
			return result;
		};
		if (snapshot.base === revision.baseTree && snapshot.head === revision.headTree) {
			return discard(ok({ kind: 'unchanged' }));
		}
		const diff = await this.#diffOf(snapshot);
		if (!diff.ok) return discard(diff);
		if (diff.value.files.length === 0) {
			if (spec.kind === 'pull-request') {
				return discard(
					ok({ kind: 'nothing-left', ...pullRequestNothingLeft(spec.pullRequest, 'open') })
				);
			}
			const uncommitted = spec.kind === 'working-tree' || spec.kind === 'staged';
			const since: CommitsSince = uncommitted
				? await commitsSince(repo, revision.baseCommit)
				: { kind: 'unknown' };
			return discard(ok({ kind: 'nothing-left', ...nothingLeft(spec, since) }));
		}
		const related = revision.store === snapshot.store.id;
		const changes = async (from: Revision['headTree'], to: Revision['headTree']) => {
			if (!related) return ok<TreeChanges>({ kind: 'unrelated' });
			const files = await readTreeDiff(snapshot.store, from, to);
			return files.ok ? ok<TreeChanges>({ kind: 'diff', files: files.value }) : files;
		};
		const heads = await changes(revision.headTree, snapshot.head);
		if (!heads.ok) return discard(heads);
		const bases = await changes(revision.baseTree, snapshot.base);
		if (!bases.ok) return discard(bases);
		const generated = await generatedPaths(
			snapshot,
			diff.value.files.map((f) => f.file.path)
		);
		if (!generated.ok) return discard(generated);
		const binary = await binaryOf(snapshot, diff.value);
		if (!binary.ok) return discard(binary);
		return ok({
			kind: 'changed',
			prepared: {
				taken: taken.value,
				diff: diff.value,
				heads: heads.value,
				bases: bases.value,
				generated: generated.value,
				binary: binary.value
			}
		});
	}

	/** How many files an update to `prepared` would change, from the current revision's state. */
	async #filesChanged(found: Current, prepared: Prepared): Promise<Result<FileCount, ReportError>> {
		const previous = await this.#contentOf(found.report, found.revision);
		if (!previous.ok) return previous;
		const { diff } = previous.value;
		return this.#db.read((q) =>
			andThen(stateOf(q, found.revision, diff), ({ state, marks }) =>
				ok(carryOver(carryOverInput(diff, state, marks, prepared)).summary.filesChanged)
			)
		);
	}

	/**
	 * The snapshot the last check kept for this revision and fingerprint, taken
	 * out of the memory so nothing else uses or deletes it; undefined when there
	 * is none, or it has gone from the store since.
	 */
	async #keptProbe(
		id: ReportId,
		revision: Revision['id'],
		fingerprint: SourceIdentity
	): Promise<Prepared | undefined> {
		const remembered = this.#checks.get(id);
		const prepared = remembered?.prepared;
		if (
			remembered?.revision !== revision ||
			remembered.fingerprint !== fingerprint ||
			prepared === undefined
		) {
			return undefined;
		}
		this.#checks.set(id, { ...remembered, prepared: undefined });
		const still = await openSnapshotRef(this.#dataDirectory, {
			store: prepared.taken.snapshot.store.id,
			snapshot: prepared.taken.snapshot.id
		});
		return still.ok ? prepared : undefined;
	}

	/** Remembers a check, deleting the snapshot an earlier one kept unless it is the same. */
	async #remember(id: ReportId, entry: Remembered): Promise<void> {
		const earlier = this.#checks.get(id)?.prepared;
		this.#checks.set(id, entry);
		if (earlier !== undefined && earlier.taken.snapshot.id !== entry.prepared?.taken.snapshot.id) {
			await this.#discard(earlier.taken.snapshot.store, earlier.taken.snapshot.id);
		}
	}

	/** Forgets a report's last check, deleting the snapshot it kept. */
	async #forget(id: ReportId): Promise<void> {
		const prepared = this.#checks.get(id)?.prepared;
		this.#checks.delete(id);
		if (prepared !== undefined) {
			await this.#discard(prepared.taken.snapshot.store, prepared.taken.snapshot.id);
		}
	}

	/** See `update`; the repository is the report's, already checked. */
	async #update(id: ReportId, repo: LocalRepository): Promise<Result<UpdateOutcome, ReportError>> {
		for (let attempt = 0; ; attempt += 1) {
			const found = this.#db.read((q) => currentOpen(q, id));
			if (!found.ok) return found;
			const { report, revision } = found.value;
			const unchanged = (): Result<UpdateOutcome, ReportError> =>
				ok({ kind: 'unchanged', report: summaryOf(report, revision) });
			// Asked for by a person, so GitHub is asked again.
			const look = await this.#lookAt(report, repo, 'person');
			if (!look.ok) return look;
			if (look.value.kind === 'nothing-left') {
				const { reason, next } = look.value;
				return ok({ kind: 'nothing-left', report: summaryOf(report, revision), reason, next });
			}
			const { fingerprint } = look.value;
			if (fingerprint === revision.fingerprint) return unchanged();
			const probe = await this.#probe(found.value, repo, fingerprint);
			if (!probe.ok) return probe;
			if (probe.value.kind === 'unchanged') {
				await this.#remember(id, {
					revision: revision.id,
					fingerprint,
					outcome: { kind: 'unchanged' },
					prepared: undefined
				});
				return unchanged();
			}
			if (probe.value.kind === 'nothing-left') {
				const { reason, next } = probe.value;
				return ok({ kind: 'nothing-left', report: summaryOf(report, revision), reason, next });
			}
			const { prepared } = probe.value;
			const { snapshot } = prepared.taken;
			const written = await this.#writeUpdate(found.value, prepared);
			if (!written.ok || written.value === 'stale') {
				await this.#discard(snapshot.store, snapshot.id);
				if (!written.ok) return written;
				if (attempt + 1 >= RETRIES) return err({ kind: 'RevisionChangedWhileSaving', report: id });
				continue;
			}
			const made = written.value;
			// Its revision refers to it now.
			this.#held.delete(heldKey(snapshot.store.id, snapshot.id));
			await this.#remember(id, {
				revision: made.revision.id,
				fingerprint: prepared.taken.identity,
				outcome: { kind: 'unchanged' },
				prepared: undefined
			});
			return ok({ kind: 'updated', report: made.report, summary: made.summary });
		}
	}

	/**
	 * Makes the next revision from `prepared`, in one transaction: reads the
	 * current revision's sections, state and marks, carries them over, and
	 * stores the new revision with them. `stale` when the current revision is
	 * no longer the one the update started from.
	 */
	async #writeUpdate(found: Current, prepared: Prepared): Promise<Result<Written, ReportError>> {
		const previous = await this.#contentOf(found.report, found.revision);
		if (!previous.ok) return previous;
		const before = previous.value.diff;
		const { taken, diff } = prepared;
		const id = found.report.id;
		return this.#db.write((q) =>
			andThen(currentOpen(q, id), (now): Result<Written, ReportError> => {
				if (now.revision.id !== found.revision.id) return ok('stale');
				return andThen(sectionsOf(q, now.revision.id), (sections) =>
					andThen(stateOf(q, now.revision, before), ({ state, marks }) => {
						const references = referencesOf(q, now.revision.id, before);
						if (!references.ok) return references;
						const overview = overviewOf(q, now.revision.id);
						if (!overview.ok) return overview;
						const input = carryOverInput(before, state, marks, prepared);
						const carried = carryOver(input);
						const at = this.#clock.now();
						const revision: Revision = {
							id: this.#ids.revisionId(),
							report: id,
							number: nextRevisionNumber(now.revision.number),
							store: taken.snapshot.store.id,
							snapshot: taken.snapshot.id,
							baseTree: taken.snapshot.base,
							headTree: taken.snapshot.head,
							fingerprint: taken.identity,
							baseCommit: taken.baseCommit,
							headCommit: taken.headCommit,
							leftOut: taken.leftOut,
							takenAt: at,
							size: diffSizeOf(diff, carried.state),
							binary: prepared.binary,
							progress: unitProgressOf(
								reviewProgress(diff, carried.state, carried.marks, 'sections')
							)
						};
						insertRevision(q, revision);
						this.#sorting.replaceSections(q, revision.id, sections);
						replaceReferenceRows(
							q,
							revision.id,
							referenceRowsOf(carryUnitSets(input, references.value))
						);
						if (overview.value !== undefined) storeOverview(q, revision.id, overview.value);
						this.#sorting.replaceAssignmentRows(
							q,
							revision.id,
							'all',
							assignmentRowsOf(diff, carried.state)
						);
						replaceReviewedRows(q, revision.id, 'all', reviewedRowsOf(carried.marks));
						insertNewUnitRows(q, revision.id, unitRowsOf(carried.fresh));
						insertUnmarkedUnitRows(q, revision.id, unitRowsOf(carried.unmarked));
						insertRevisionUpdate(q, revision.id, carried.summary);
						touchReport(q, id, at);
						return ok({
							report: summaryOf({ ...now.report, lastActivityAt: at }, revision),
							revision,
							summary: carried.summary
						});
					})
				);
			})
		);
	}

	/**
	 * Reads the revision `seen`'s diff, then runs `change` on its state in one
	 * write transaction and stores the state and marks it returns, with the
	 * revision's progress. Refused with `VersionOutOfDate`, changing nothing, when
	 * `seen` is not the current revision, also when a new one appears meanwhile.
	 */
	async #changeState<T>(
		id: ReportId,
		seen: RevisionNumber,
		change: (
			q: Queries,
			revision: Revision,
			diff: Diff,
			state: AssignmentState,
			marks: ReviewedMarks
		) => Result<{ result: T; state: AssignmentState; marks: ReviewedMarks }, ReportError>
	): Promise<Result<T, ReportError>> {
		const found = this.#db.read((q) => currentAsSeen(q, id, seen));
		if (!found.ok) return found;
		const { report, revision } = found.value;
		const content = await this.#contentOf(report, revision);
		if (!content.ok) return content;
		const { diff } = content.value;
		return this.#db.write((q) =>
			andThen(currentAsSeen(q, id, seen), (now): Result<T, ReportError> => {
				// The same number on another revision cannot happen; checked so it never goes unseen.
				if (now.revision.id !== revision.id) {
					return err({ kind: 'RevisionChangedWhileSaving', report: id });
				}
				return andThen(stateOf(q, revision, diff), ({ state, marks }) =>
					andThen(change(q, revision, diff, state, marks), (changed) => {
						setRevisionProgress(
							q,
							revision.id,
							unitProgressOf(reviewProgress(diff, changed.state, changed.marks, 'sections')),
							diffSizeOf(diff, changed.state)
						);
						touchReport(q, id, this.#clock.now());
						this.#frameVersions.edited(revision.id);
						return ok(changed.result);
					})
				);
			})
		);
	}

	/**
	 * The revision's snapshot and diff, and the revision as stored once its rows
	 * are up to date (`#complete`). Everything that reads a revision's rows
	 * reads its diff through this first.
	 */
	async #contentOf(
		report: Report,
		revision: Revision
	): Promise<Result<{ snapshot: Snapshot; diff: Diff; revision: Revision }, ReportError>> {
		const snapshot = await this.#snapshotOf(report, revision);
		if (!snapshot.ok) return snapshot;
		const diff = await this.#diffOf(snapshot.value);
		if (!diff.ok) return diff;
		const completed = await this.#complete(revision, snapshot.value, diff.value);
		if (!completed.ok) return completed;
		return ok({ snapshot: snapshot.value, diff: diff.value, revision: completed.value });
	}

	/**
	 * Brings a revision an earlier diff delver saved up to date. One saved
	 * before a file with lines could also have a file-level unit
	 * (`revisions_to_check`) is brought up to date once: each such unit without
	 * a row gets what a first version would have given it (the built-in ignore
	 * rules and the snapshot's `linguist-generated` paths, the role its path
	 * suggests, and no reviewed mark), and the revision's stored progress and
	 * test lines are computed again from its rows. One whose binary files were
	 * not counted has them counted (`#countBinary`). Either way the list of
	 * diffs, the page and the command then agree. Reads the database and the
	 * store only, never the reviewed repository; for any other revision it is
	 * one small query. Returns the revision as now stored.
	 */
	async #complete(
		revision: Revision,
		snapshot: Snapshot,
		diff: Diff
	): Promise<Result<Revision, ReportError>> {
		const rows = this.#db.read((q) =>
			isToCheck(q, revision.id) ? map(assignmentRowsFor(q, revision.id), (r) => [r]) : ok([])
		);
		if (!rows.ok) return rows;
		const [stored] = rows.value;
		if (stored === undefined) {
			return revision.binary === undefined
				? this.#countBinary(revision, snapshot, diff)
				: ok(revision);
		}
		const missing = pathsMissingFileUnit(diff, stored);
		const generated =
			missing.size === 0 ? ok(new Set<RepoPath>()) : await generatedPaths(snapshot, [...missing]);
		if (!generated.ok) return generated;
		const binary =
			revision.binary === undefined ? await binaryOf(snapshot, diff) : ok(revision.binary);
		if (!binary.ok) return binary;
		const first = autoIgnore(diff, initialState(diff), { markedGenerated: generated.value }).state;
		return this.#db.write((q) => {
			if (!isToCheck(q, revision.id)) {
				return map(
					revisionsOf(q, revision.report),
					(all) => all.find((r) => r.id === revision.id) ?? revision
				);
			}
			return andThen(assignmentRowsFor(q, revision.id), (now) => {
				const lacking = pathsMissingFileUnit(diff, now);
				const added = assignmentRowsOf(diff, first, lacking).filter((r) => r.units.kind === 'file');
				const complete = [...now, ...added];
				return andThen(assignmentStateFromRows(diff, complete), (state) =>
					andThen(reviewedRowsFor(q, revision.id), (marked) =>
						andThen(reviewedMarksFromRows(diff, marked), (marks): Result<Revision, ReportError> => {
							const progress = unitProgressOf(reviewProgress(diff, state, marks, 'sections'));
							const size = diffSizeOf(diff, state);
							this.#sorting.replaceAssignmentRows(
								q,
								revision.id,
								lacking,
								complete.filter((r) => lacking.has(r.path))
							);
							setRevisionProgress(q, revision.id, progress, size);
							setRevisionBinary(q, revision.id, binary.value);
							checkedRevision(q, revision.id);
							return ok({ ...revision, size, binary: binary.value, progress });
						})
					)
				);
			});
		});
	}

	/** Counts the binary files of a revision an earlier diff delver did not, and records them. */
	async #countBinary(
		revision: Revision,
		snapshot: Snapshot,
		diff: Diff
	): Promise<Result<Revision, ReportError>> {
		const binary = await binaryOf(snapshot, diff);
		if (!binary.ok) return binary;
		return this.#db.write((q) => {
			setRevisionBinary(q, revision.id, binary.value);
			return ok({ ...revision, binary: binary.value });
		});
	}

	/** `#countBinary`, reading the diff past the cache of diffs, which is for the pages being read. */
	async #countFromStore(
		revision: Revision,
		snapshot: Snapshot
	): Promise<Result<Revision, ReportError>> {
		const files = await readSnapshotDiff(snapshot);
		const diff = files.ok ? makeDiff(files.value) : files;
		return diff.ok ? this.#countBinary(revision, snapshot, diff.value) : diff;
	}

	/**
	 * Counts the binary files of every revision an earlier diff delver saved
	 * without them, one revision at a time, each report's current one first,
	 * since the list shows those. The daemon starts it once it is serving, so a
	 * start is never held up by it: until a revision is counted, the list and
	 * its page say nothing of its binary files, and a revision read before its
	 * turn is counted then (`#complete`). Each count reads the diff from the
	 * store and writes one row in a transaction of its own that only fills
	 * columns still empty, so it never undoes another write; a revision
	 * deleted meanwhile is skipped. Stops before the next revision once `stop`
	 * fires. Returns the revisions it counted, in order.
	 */
	async countBinaryFiles(stop?: AbortSignal): Promise<readonly RevisionId[]> {
		const due = this.#db.read((q) => revisionsWithoutBinary(q));
		if (!due.ok) {
			this.#logOnce(
				`The binary files of diffs saved by an earlier diff delver could not be listed: ${JSON.stringify(due.error)}`
			);
			return [];
		}
		const counted: RevisionId[] = [];
		for (const { report: reportId, revision: revisionId } of due.value) {
			if (stop?.aborted === true) break;
			const found = this.#db.read((q) =>
				andThen(reportById(q, reportId), (report) =>
					map(revisionsOf(q, reportId), (revisions) => ({
						report,
						revision: revisions.find((r) => r.id === revisionId)
					}))
				)
			);
			if (!found.ok) {
				this.#logOnce(
					`A diff saved by an earlier diff delver (${reportId}) could not be read to count its binary files: ${JSON.stringify(found.error)}`
				);
				continue;
			}
			const { report, revision } = found.value;
			// Deleted, or counted when it was read, since the list was taken.
			if (report === undefined || revision === undefined || revision.binary !== undefined) continue;
			const snapshot = await this.#snapshotOf(report, revision);
			// A revision whose snapshot is gone can never be shown.
			if (!snapshot.ok && snapshot.error.kind === 'SnapshotGone') continue;
			const done = snapshot.ok ? await this.#countFromStore(revision, snapshot.value) : snapshot;
			if (done.ok) counted.push(revision.id);
			else {
				this.#logOnce(
					`The binary files of a diff saved by an earlier diff delver (${reportId}) could not be counted yet: ${JSON.stringify(done.error)}`
				);
			}
		}
		return counted;
	}

	/**
	 * Brings every revision written before a file with lines could also have a
	 * file-level unit up to date (`#complete`), when the service opens, before
	 * the daemon serves, so the list of diffs and its progress are right before
	 * any of them is opened. Only revisions from before migration 4 are listed,
	 * so a database that has none costs one query. Counting the binary files an
	 * earlier diff delver did not count is left to `countBinaryFiles`, after
	 * the daemon is serving. A revision whose snapshot is gone can never be
	 * shown and is left as it is; one that cannot be brought up to date now is
	 * tried again when it is next read.
	 */
	async #checkOldRevisions(): Promise<void> {
		const due = this.#db.read((q) => revisionsToCheck(q));
		if (!due.ok) {
			this.#logOnce(
				`Diffs saved by an earlier diff delver could not be listed: ${JSON.stringify(due.error)}`
			);
			return;
		}
		for (const { report: reportId, revision: revisionId } of due.value) {
			const found = this.#db.read((q) =>
				andThen(reportById(q, reportId), (report) =>
					map(revisionsOf(q, reportId), (revisions) => ({
						report,
						revision: revisions.find((r) => r.id === revisionId)
					}))
				)
			);
			if (!found.ok || found.value.report === undefined || found.value.revision === undefined) {
				this.#logOnce(
					`A diff saved by an earlier diff delver (${reportId}) could not be read: ${found.ok ? 'it has gone' : JSON.stringify(found.error)}`
				);
				continue;
			}
			const { report, revision } = found.value;
			const done = await this.#contentOf(report, revision);
			if (done.ok) continue;
			if (done.error.kind === 'SnapshotGone') {
				this.#db.write((q) => {
					checkedRevision(q, revision.id);
					return ok(undefined);
				});
			} else {
				this.#logOnce(
					`A diff saved by an earlier diff delver (${reportId}) could not be brought up to date yet: ${JSON.stringify(done.error)}`
				);
			}
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

/**
 * Takes the changes the reviewer has just marked out of the units the update
 * that made this revision unmarked, for the files the mark touched.
 */
function forgetMarkedAgain(
	q: Queries,
	revision: RevisionId,
	diff: Diff,
	marks: ReviewedMarks,
	files: ReadonlySet<RepoPath>
): Result<void, ReportError> {
	const rows: UnitRow[] = [];
	for (const path of files) {
		const found = unmarkedUnitRowsFor(q, revision, path);
		if (!found.ok) return found;
		rows.push(...found.value);
	}
	if (rows.length === 0) return ok(undefined);
	const unmarked = unitSetFromRows(diff, rows, 'unmarked changes');
	if (!unmarked.ok) return unmarked;
	replaceUnmarkedUnitRows(
		q,
		revision,
		files,
		unitRowsOf(withoutUnits(unmarked.value, marks), files)
	);
	return ok(undefined);
}

/** Whether a side of a file is a file of its own, and not a link or a submodule. */
function isPlainFile(version: FileVersion): boolean {
	const kind = fileModeKind(version.mode);
	return kind === 'regular' || kind === 'executable';
}

/**
 * A side of a file as a part shows it beside an image, read from the snapshot
 * by the path it has on that side, of which only the start is read: undefined
 * when the file does not have it; its format and size when it is an image,
 * marked when it is larger than the page shows; and what it is when it is no
 * picture.
 */
async function imageSideOf(
	snapshot: Snapshot,
	side: Side,
	version: FileVersion | undefined
): Promise<Result<ImageSide | undefined, ReportError>> {
	if (version === undefined) return ok(undefined);
	const entry = await snapshotEntry(snapshot, side, version.path);
	if (!entry.ok) return entry;
	if (entry.value.kind !== 'file') return err({ kind: 'PathNotFound', side, path: version.path });
	const size = entry.value.size;
	if (!isPlainFile(version)) return ok({ kind: 'other', what: 'link', size });
	// Only its start: enough to know its format, or whether it is binary.
	const read = await readSnapshotFileStart(
		snapshot,
		side,
		version.path,
		bytesToKnowFormat(version.path)
	);
	if (!read.ok) return read;
	const format = imageFormatOf(version.path, read.value.start);
	if (format === undefined) {
		return ok({ kind: 'other', what: looksBinary(read.value.start) ? 'binary' : 'text', size });
	}
	return ok(
		size > MAX_IMAGE_SIZE ? { kind: 'too-large', format, size } : { kind: 'image', format, size }
	);
}
