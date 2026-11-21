/**
 * Reports and revisions to store in a database test, with fixed ids and times.
 * Only the tables are tested with these; the report service makes real ones.
 */
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseFileCount } from '#lib/core/file-count.tiny.ts';
import { parseLineCount } from '#lib/core/line-count.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { gitReportIdentity } from '#lib/core/reports/report-identity.ts';
import type { Report, Revision } from '#lib/core/reports/report.ts';
import { parseRepositoryName } from '#lib/core/repository-name.tiny.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import { FIRST_REVISION } from '#lib/core/revision-number.tiny.ts';
import { parseSnapshotId } from '#lib/core/snapshot-id.tiny.ts';
import { parseSourceIdentity } from '#lib/core/source-identity.tiny.ts';
import { WORKING_TREE, type GitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { parseStoreId } from '#lib/core/store-id.tiny.ts';
import { parseTimestamp, type Timestamp } from '#lib/core/timestamp.tiny.ts';
import { parseTreeId } from '#lib/core/tree-id.tiny.ts';
import { NO_UNITS } from '#lib/core/unit-count.tiny.ts';
import { reviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { value } from './git-source-helpers.ts';
import { absolutePath } from './git-repo.ts';

export const STORE = value(parseStoreId('repo-0123'));
export const WORKTREE: AbsolutePath = absolutePath('/work/repo');

export function at(ms: number): Timestamp {
	return value(parseTimestamp(ms));
}

/** An open report of the working tree in `worktree`. */
export function aReport(
	id: ReportId,
	worktree: AbsolutePath = WORKTREE,
	spec: GitSourceSpec = WORKING_TREE
): Report {
	return {
		id,
		identity: gitReportIdentity({ store: STORE, spec, worktree }),
		source: { kind: 'git', spec, run: undefined },
		store: STORE,
		repositoryName: value(parseRepositoryName('/work/repo/.git')),
		repositoryPath: worktree,
		state: { kind: 'open' },
		createdAt: at(1_000),
		lastActivityAt: at(2_000)
	};
}

/** Revision 1 of a report, with a snapshot id made from `n`. */
export function aRevision(id: RevisionId, report: ReportId, n = 1): Revision {
	return {
		id,
		report,
		number: FIRST_REVISION,
		store: STORE,
		snapshot: value(parseSnapshotId(n.toString(16).padStart(32, '0'))),
		baseTree: value(parseTreeId('4b825dc642cb6eb9a060e54bf8d69288fbee4904')),
		headTree: value(parseTreeId('4b825dc642cb6eb9a060e54bf8d69288fbee4904')),
		fingerprint: value(parseSourceIdentity('a'.repeat(64))),
		baseCommit: undefined,
		headCommit: undefined,
		leftOut: [reviewerMessage('caf\\xE9.txt could not be read.')],
		takenAt: at(1_500),
		size: {
			files: value(parseFileCount(2)),
			addedLines: value(parseLineCount(3)),
			deletedLines: value(parseLineCount(1))
		},
		progress: { counted: NO_UNITS, reviewed: NO_UNITS, ignored: NO_UNITS, uncategorised: NO_UNITS }
	};
}
