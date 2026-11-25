/**
 * Reports and their revisions (DESIGN 6), as the database holds them and the
 * service hands them out. A report follows one source over time; each revision
 * is one frozen snapshot of it with its breakdown into sections.
 */
import type { AbsolutePath } from '../absolute-path.tiny.ts';
import type { AgentMarkdown } from '../agent-markdown.tiny.ts';
import type { CommitId } from '../commit-id.tiny.ts';
import type { CommitRun } from '../history/commit-run.ts';
import type { ReportId } from '../report-id.tiny.ts';
import type { ReportIdentity } from '../report-identity.tiny.ts';
import type { RepositoryName } from '../repository-name.tiny.ts';
import type { ReviewerMessage } from '../reviewer-message.tiny.ts';
import type { RevisionId } from '../revision-id.tiny.ts';
import type { RevisionNumber } from '../revision-number.tiny.ts';
import type { SectionId } from '../section-id.tiny.ts';
import type { SectionTitle } from '../section-title.tiny.ts';
import type { SnapshotId } from '../snapshot-id.tiny.ts';
import type { SourceIdentity } from '../source-identity.tiny.ts';
import type { GitSourceSpec } from '../sources/git-source-spec.ts';
import type { SourceSpec } from '../sources/source-spec.ts';
import type { PullRequestRef } from '../github/pull-request.ts';
import type { PullRequestDescription } from '../github/pull-request-description.tiny.ts';
import type { PullRequestTitle } from '../github/pull-request-title.tiny.ts';
import type { StoreId } from '../store-id.tiny.ts';
import type { Timestamp } from '../timestamp.tiny.ts';
import type { TreeId } from '../tree-id.tiny.ts';
import type { UnitCount } from '../unit-count.tiny.ts';
import type { BinaryFiles, DiffSize } from './diff-size.ts';

export type { DiffSize } from './diff-size.ts';

/**
 * What a report follows: a local git source, or a GitHub pull request. Later:
 * jj changes.
 *
 * For git, `run` is what its title is made of when the source is a run of
 * commits, read when the report was opened; undefined for any other source,
 * for a range between two commit ids that is not such a run, and for a report
 * opened before runs were kept.
 *
 * For a pull request, its title and description as GitHub gave them when the
 * report was opened or last brought up to date.
 */
export type ReportSource =
	| {
			readonly kind: 'git';
			readonly spec: GitSourceSpec;
			readonly run: CommitRun | undefined;
	  }
	| {
			readonly kind: 'github';
			readonly pullRequest: PullRequestRef;
			readonly title: PullRequestTitle;
			readonly description: PullRequestDescription | undefined;
	  };

/** Why a report was closed. */
export type ClosedReason =
	/** The reviewer closed it. */
	| 'reviewer'
	/** Its source has nothing to review any more: the changes were committed, merged or discarded. */
	| 'source-empty'
	/**
	 * Its saved snapshot is gone from the data folder, so it could not be shown;
	 * opening its source again started a new report in its place.
	 */
	| 'snapshot-gone';

export type ReportState =
	{ readonly kind: 'open' } | { readonly kind: 'closed'; readonly reason: ClosedReason };

export interface Report {
	readonly id: ReportId;
	readonly identity: ReportIdentity;
	readonly source: ReportSource;
	/** The store that holds its snapshots. */
	readonly store: StoreId;
	/** The repository as its store names it. */
	readonly repositoryName: RepositoryName;
	/** Where the repository was opened: its worktree, or its git directory when it has none. */
	readonly repositoryPath: AbsolutePath;
	readonly state: ReportState;
	readonly createdAt: Timestamp;
	/** The last time anything about it changed. */
	readonly lastActivityAt: Timestamp;
}

/**
 * A revision's progress in units, for the reports list (DESIGN 5): `counted` is
 * every unit outside Ignored, `reviewed` those of them marked reviewed.
 */
export interface UnitProgress {
	readonly counted: UnitCount;
	readonly reviewed: UnitCount;
	readonly ignored: UnitCount;
	readonly uncategorised: UnitCount;
}

export interface Revision {
	readonly id: RevisionId;
	readonly report: ReportId;
	readonly number: RevisionNumber;
	readonly store: StoreId;
	readonly snapshot: SnapshotId;
	readonly baseTree: TreeId;
	readonly headTree: TreeId;
	/** The source's fingerprint just before the snapshot was taken. */
	readonly fingerprint: SourceIdentity;
	/** The commit the old side is, when it is one. */
	readonly baseCommit: CommitId | undefined;
	/** The commit the new side is, when it is one (not for the working tree or the index). */
	readonly headCommit: CommitId | undefined;
	/** What could not be included, one sentence each, which the reviewer must be shown. */
	readonly leftOut: readonly ReviewerMessage[];
	readonly takenAt: Timestamp;
	/** Its size, kept up to date with the roles of its lines, as `progress` is. */
	readonly size: DiffSize;
	/**
	 * Its binary files and their sizes; undefined only for a revision an
	 * earlier diff delver saved whose snapshot could not be read since.
	 */
	readonly binary: BinaryFiles | undefined;
	readonly progress: UnitProgress;
}

/** A section of a revision's breakdown, written by the agent (DESIGN 4.2). */
export interface Section {
	readonly id: SectionId;
	readonly title: SectionTitle;
	readonly summary: AgentMarkdown | undefined;
}

/** The source a report follows, as it is opened again: its git source, or its pull request. */
export function sourceSpecOf(source: ReportSource): SourceSpec {
	return source.kind === 'git'
		? source.spec
		: { kind: 'pull-request', pullRequest: source.pullRequest };
}
