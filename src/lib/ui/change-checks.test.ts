import { describe, expect, it } from 'vitest';
import { parseReportId } from '#lib/core/report-id.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { value } from '../../../tests/support/git-source-helpers.ts';
import { ChangeChecks, type Shown } from './change-checks.ts';

const diff = value(parseReportId('r_1'));
const version = (n: number) => value(parseRevisionNumber(n));
const first: Shown = { id: diff, version: version(1) };
const second: Shown = { id: diff, version: version(2) };

describe('the checks a diff page makes', () => {
	it('drops an answer for a version the page no longer shows', () => {
		const checks = new ChangeChecks();
		const slow = checks.start(first, true);
		if (slow === undefined) throw new Error('not started');
		// Update shows version 2 while the check of version 1 is under way.
		const fresh = checks.start(second, false);
		if (fresh === undefined) throw new Error('not started');
		expect(checks.finish(fresh, second)).toBe(true);
		expect(checks.finish(slow, second)).toBe(false);
		// Even if the page went back to the same version, a later check has answered since.
		expect(checks.finish(checks.start(first, false) ?? fresh, second)).toBe(false);
	});

	it('starts no check in the background while one is under way', () => {
		const checks = new ChangeChecks();
		const focus = checks.start(first, true);
		if (focus === undefined) throw new Error('not started');
		// The window got the focus and became visible at once.
		expect(checks.start(first, true)).toBeUndefined();
		expect(checks.finish(focus, first)).toBe(true);
		expect(checks.start(first, true)).toBeDefined();
	});
});
