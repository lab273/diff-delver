import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { partIndexOf, type PartIndex } from '../part-index.tiny.ts';
import {
	nextShown,
	nextWaiting,
	previousShown,
	previousWaiting,
	shownParts
} from './reading-order.ts';

const at = partIndexOf;

describe('reading order', () => {
	it('goes to the next part that waits, round past the end, and says when none does', () => {
		const waiting = [false, true, false, true];
		expect(nextWaiting(waiting)).toBe(1);
		expect(nextWaiting(waiting, at(1))).toBe(3);
		expect(nextWaiting(waiting, at(3))).toBe(1);
		expect(nextWaiting([false, true], at(1))).toBe(1);
		expect(nextWaiting([false, false])).toBeUndefined();
		expect(nextWaiting([])).toBeUndefined();
		expect(previousWaiting(waiting)).toBe(3);
		expect(previousWaiting(waiting, at(1))).toBe(3);
		expect(previousWaiting(waiting, at(3))).toBe(1);
	});

	it('steps through the parts shown, stopping at either end', () => {
		const all = [true, true, true];
		expect([nextShown(all), nextShown(all, at(0)), nextShown(all, at(2))]).toEqual([
			0,
			1,
			undefined
		]);
		expect([previousShown(all), previousShown(all, at(2)), previousShown(all, at(0))]).toEqual([
			2,
			1,
			undefined
		]);
		expect(nextShown([])).toBeUndefined();
		// From a part that has just gone from the page, on to the one shown after where it was.
		const shown = [true, false, false, true, false];
		expect(nextShown(shown, at(2))).toBe(3);
		expect(previousShown(shown, at(2))).toBe(0);
		expect(nextShown(shown, at(3))).toBeUndefined();
	});

	it('visits every part that waits exactly once before coming round again, from anywhere', () => {
		fc.assert(
			fc.property(fc.array(fc.boolean(), { maxLength: 40 }), fc.nat(), (waiting, seed) => {
				const count = waiting.filter(Boolean).length;
				const from = waiting.length === 0 ? undefined : at(seed % waiting.length);
				const visits: PartIndex[] = [];
				let next = nextWaiting(waiting, from);
				for (let step = 0; step < count && next !== undefined; step += 1) {
					visits.push(next);
					next = nextWaiting(waiting, next);
				}
				expect([...visits].sort((a, b) => a - b)).toEqual(
					waiting.flatMap((w, i) => (w ? [i] : []))
				);
				// After all of them, the first comes round again.
				expect(next).toBe(visits[0]);
				// Backwards visits the same parts in the opposite order.
				if (count > 1 && visits[1] !== undefined) {
					expect(previousWaiting(waiting, visits[1])).toBe(visits[0]);
				}
			})
		);
	});

	it('from any place, with any parts hidden, visits the shown parts in order, none skipped or repeated', () => {
		fc.assert(
			fc.property(
				fc.array(fc.boolean(), { maxLength: 40 }),
				fc.option(fc.nat(), { nil: undefined }),
				(shown, seed) => {
					const from =
						seed === undefined || shown.length === 0 ? undefined : at(seed % shown.length);
					const after = shown.flatMap((s, i) => (s && (from === undefined || i > from) ? [i] : []));
					const before = shown
						.flatMap((s, i) => (s && (from === undefined || i < from) ? [i] : []))
						.reverse();
					const walk = (step: (place?: PartIndex) => PartIndex | undefined): number[] => {
						const visits: number[] = [];
						for (let place = step(from); place !== undefined; place = step(place)) {
							visits.push(place);
							if (visits.length > shown.length) break;
						}
						return visits;
					};
					expect(walk((place) => nextShown(shown, place))).toEqual(after);
					expect(walk((place) => previousShown(shown, place))).toEqual(before);
				}
			)
		);
	});

	it('shows every part, or only those that wait', () => {
		expect(shownParts([true, false, true], false)).toEqual([true, true, true]);
		expect(shownParts([true, false, true], true)).toEqual([true, false, true]);
	});
});
