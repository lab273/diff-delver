/**
 * Where ids come from. Nothing makes an id itself: the daemon is given an
 * `IdSource`, so tests and journeys get the same ids on every run. The random
 * source is in `#lib/server/system.ts`.
 */
import { parseReviewMark, type ReviewMark } from './github/review-mark.tiny.ts';
import { parseReportId, type ReportId } from './report-id.tiny.ts';
import { parseRevisionId, type RevisionId } from './revision-id.tiny.ts';
import { parseSnapshotId, type SnapshotId } from './snapshot-id.tiny.ts';

export interface IdSource {
	/** A report id never handed out before. */
	reportId(): ReportId;
	/** A revision id never handed out before. */
	revisionId(): RevisionId;
	/** A snapshot id never handed out before, for a snapshot in a store. */
	snapshotId(): SnapshotId;
	/** The secret part of the mark of a review posted to GitHub, never handed out before. */
	reviewMark(): ReviewMark;
}

/**
 * Ids made from a counter, for tests and journeys: `r_1`, `r_2`, ..., `v_1`,
 * `v_2`, ... and snapshots `000…01`, `000…02`, ..., and so the marks of reviews
 * posted to GitHub, each kind counted
 * separately. `prefix`, lowercase letters or digits, keeps two sources in one
 * data directory apart; in a snapshot id it is written as the hex of its
 * characters, so it can be up to 14 characters long.
 */
export function sequentialIds(prefix = ''): IdSource {
	let reports = 0;
	let revisions = 0;
	let snapshots = 0;
	let marks = 0;
	const snapshotPrefix = Array.from({ length: prefix.length }, (_, i) =>
		prefix.charCodeAt(i).toString(16).padStart(2, '0')
	).join('');
	const made = <T>(parsed: { ok: true; value: T } | { ok: false }, text: string): T => {
		if (!parsed.ok) throw new RangeError(`Not an id: ${text}`);
		return parsed.value;
	};
	return {
		reportId: () => {
			reports += 1;
			const text = `r_${prefix}${String(reports)}`;
			return made(parseReportId(text), text);
		},
		revisionId: () => {
			revisions += 1;
			const text = `v_${prefix}${String(revisions)}`;
			return made(parseRevisionId(text), text);
		},
		snapshotId: () => {
			snapshots += 1;
			const text = `${snapshotPrefix}${snapshots.toString(16).padStart(32 - snapshotPrefix.length, '0')}`;
			return made(parseSnapshotId(text), text);
		},
		reviewMark: () => {
			marks += 1;
			const text = `${snapshotPrefix}${marks.toString(16).padStart(32 - snapshotPrefix.length, '0')}`;
			return made(parseReviewMark(text), text);
		}
	};
}
