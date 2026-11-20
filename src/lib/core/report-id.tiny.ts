import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * A report (DESIGN 6.1): `r_` and 1 to 32 lowercase letters or digits, such as
 * `r_7f3a9c01b2d4e6f8`. Made by an id source (`ids.ts`), never by hand, so tests
 * and journeys can supply their own.
 */
export type ReportId = Tiny<string, 'ReportId'>;

export interface InvalidReportId {
	readonly kind: 'InvalidReportId';
	readonly value: string;
}

export function parseReportId(value: string): Result<ReportId, InvalidReportId> {
	if (!/^r_[0-9a-z]{1,32}$/.test(value)) return err({ kind: 'InvalidReportId', value });
	return ok(value as ReportId);
}
