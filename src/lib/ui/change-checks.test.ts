import { describe, expect, it } from 'vitest';
import { parseReportId } from '#lib/core/report-id.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { value } from '../../../tests/support/git-source-helpers.ts';
import type { Milliseconds } from '#lib/core/milliseconds.tiny.ts';
import { ChangeChecks, CHECK_GIVES_UP_AFTER, type Shown, type Timer } from './change-checks.ts';

/** A timer the test fires by hand. */
class HandTimer implements Timer {
	readonly waiting: { ms: Milliseconds; then: () => void; cancelled: boolean }[] = [];
	after(ms: Milliseconds, then: () => void): () => void {
		const entry = { ms, then, cancelled: false };
		this.waiting.push(entry);
		return () => {
			entry.cancelled = true;
		};
	}
	/** Fires every timer still set. */
	fire(): void {
		for (const entry of this.waiting.splice(0)) if (!entry.cancelled) entry.then();
	}
	get set(): number {
		return this.waiting.filter((e) => !e.cancelled).length;
	}
}

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

	it('lets the next check start once one has gone unanswered for too long', () => {
		const timer = new HandTimer();
		const checks = new ChangeChecks(timer);
		const lost = checks.start(first, true);
		if (lost === undefined) throw new Error('not started');
		expect(timer.waiting.map((w) => w.ms)).toEqual([CHECK_GIVES_UP_AFTER]);
		expect(checks.start(first, true)).toBeUndefined();
		// Its request never returns: the check ends when the time is up.
		timer.fire();
		const next = checks.start(first, true);
		if (next === undefined) throw new Error('not started after the first gave up');
		// The lost answer, if it comes at last, does not end the check now under way.
		expect(checks.finish(lost, first)).toBe(false);
		expect(checks.start(first, true)).toBeUndefined();
		expect(checks.finish(next, first)).toBe(true);
		// A check that answers in time leaves no timer set.
		expect(timer.set).toBe(0);
	});
});
