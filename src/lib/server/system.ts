/**
 * The real clock and random ids, for the daemon. Tests and journeys pass a
 * `settableClock` and `sequentialIds` (`#lib/core/clock.ts`, `#lib/core/ids.ts`)
 * instead, so what they see is the same on every run.
 */
import { randomBytes } from 'node:crypto';
import type { Clock } from '#lib/core/clock.ts';
import type { IdSource } from '#lib/core/ids.ts';
import { parseReportId } from '#lib/core/report-id.tiny.ts';
import { parseRevisionId } from '#lib/core/revision-id.tiny.ts';
import { parseTimestamp } from '#lib/core/timestamp.tiny.ts';

/** The time as the machine tells it. */
export const systemClock: Clock = {
	now: () => {
		const now = parseTimestamp(Date.now());
		if (!now.ok) throw new RangeError('The system clock is before 1970.');
		return now.value;
	}
};

/** 16 random lowercase hex digits: 64 bits, enough that two never meet. */
function randomPart(): string {
	return randomBytes(8).toString('hex');
}

/** Ids made at random. */
export const randomIds: IdSource = {
	reportId: () => {
		const id = parseReportId(`r_${randomPart()}`);
		if (!id.ok) throw new Error('A random report id did not parse.');
		return id.value;
	},
	revisionId: () => {
		const id = parseRevisionId(`v_${randomPart()}`);
		if (!id.ok) throw new Error('A random revision id did not parse.');
		return id.value;
	}
};
