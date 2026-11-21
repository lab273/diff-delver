import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	nextPart,
	nextWaiting,
	previousPart,
	previousWaiting,
	shownParts
} from './reading-order.ts';

describe('reading order', () => {
	it('goes to the next part that waits, round past the end, and says when none does', () => {
		const waiting = [false, true, false, true];
		expect(nextWaiting(waiting)).toBe(1);
		expect(nextWaiting(waiting, 1)).toBe(3);
		expect(nextWaiting(waiting, 3)).toBe(1);
		expect(nextWaiting([false, true], 1)).toBe(1);
		expect(nextWaiting([false, false])).toBeUndefined();
		expect(nextWaiting([])).toBeUndefined();
		expect(previousWaiting(waiting)).toBe(3);
		expect(previousWaiting(waiting, 1)).toBe(3);
		expect(previousWaiting(waiting, 3)).toBe(1);
	});

	it('steps through every part, stopping at either end', () => {
		expect([nextPart(3), nextPart(3, 0), nextPart(3, 2)]).toEqual([0, 1, undefined]);
		expect([previousPart(3), previousPart(3, 2), previousPart(3, 0)]).toEqual([2, 1, undefined]);
		expect(nextPart(0)).toBeUndefined();
	});

	it('visits every part that waits exactly once before coming round again, from anywhere', () => {
		fc.assert(
			fc.property(fc.array(fc.boolean(), { maxLength: 40 }), fc.nat(), (waiting, seed) => {
				const count = waiting.filter(Boolean).length;
				const from = waiting.length === 0 ? undefined : seed % waiting.length;
				const visits: number[] = [];
				let at = nextWaiting(waiting, from);
				for (let step = 0; step < count && at !== undefined; step += 1) {
					visits.push(at);
					at = nextWaiting(waiting, at);
				}
				expect([...visits].sort((a, b) => a - b)).toEqual(
					waiting.flatMap((w, i) => (w ? [i] : []))
				);
				// After all of them, the first comes round again.
				expect(at).toBe(visits[0]);
				// Backwards visits the same parts in the opposite order.
				if (count > 1 && visits[1] !== undefined) {
					expect(previousWaiting(waiting, visits[1])).toBe(visits[0]);
				}
			})
		);
	});

	it('shows every part, or only those that wait', () => {
		expect(shownParts([true, false, true], false)).toEqual([0, 1, 2]);
		expect(shownParts([true, false, true], true)).toEqual([0, 2]);
	});
});
