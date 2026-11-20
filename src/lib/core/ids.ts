/**
 * Where ids come from. Nothing makes an id itself: the daemon is given an
 * `IdSource`, so tests and journeys get the same ids on every run. The random
 * source is in `#lib/server/system.ts`.
 */
import { parseReportId, type ReportId } from './report-id.tiny.ts';
import { parseRevisionId, type RevisionId } from './revision-id.tiny.ts';

export interface IdSource {
	/** A report id never handed out before. */
	reportId(): ReportId;
	/** A revision id never handed out before. */
	revisionId(): RevisionId;
}

/**
 * Ids made from a counter, for tests and journeys: `r_1`, `r_2`, ... and `v_1`,
 * `v_2`, ..., each kind counted separately. `prefix`, lowercase letters or
 * digits, keeps two sources in one data directory apart.
 */
export function sequentialIds(prefix = ''): IdSource {
	let reports = 0;
	let revisions = 0;
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
		}
	};
}
