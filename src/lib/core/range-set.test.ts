import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RangeMap } from './range-map.ts';
import { RangeSet } from './range-set.ts';

const small = fc.integer({ min: -20, max: 60 });
const interval = fc
	.tuple(small, fc.integer({ min: 0, max: 12 }))
	.map(([first, width]) => ({ first, last: first + width }));
const rangeSet = fc.array(interval, { maxLength: 6 }).map((i) => RangeSet.fromIntervals(i));

const naive = (set: RangeSet): readonly number[] => [...set.values()];
const sortedUnique = (ns: Iterable<number>): readonly number[] =>
	[...new Set(ns)].sort((a, b) => a - b);

/** The intervals are sorted, disjoint and never touch. */
function wellFormed(set: RangeSet): boolean {
	return set.intervals.every(
		(x, i) => x.first <= x.last && (i === 0 || (set.intervals[i - 1]?.last ?? 0) + 1 < x.first)
	);
}

describe('RangeSet', () => {
	it('merges overlapping and adjacent intervals', () => {
		const set = RangeSet.fromIntervals([
			{ first: 5, last: 7 },
			{ first: 1, last: 2 },
			{ first: 3, last: 3 },
			{ first: 6, last: 9 },
			{ first: 12, last: 12 }
		]);
		expect(set.intervals).toEqual([
			{ first: 1, last: 3 },
			{ first: 5, last: 9 },
			{ first: 12, last: 12 }
		]);
		expect(set.size).toBe(9);
		expect([set.min, set.max]).toEqual([1, 12]);
	});

	it('rejects intervals that are reversed or not whole', () => {
		expect(() => RangeSet.of(3, 2)).toThrow(RangeError);
		expect(() => RangeSet.of(1.5)).toThrow(RangeError);
	});

	it('agrees with a set of numbers under union, intersection and difference', () => {
		fc.assert(
			fc.property(rangeSet, rangeSet, (a, b) => {
				const sa = new Set(naive(a));
				const sb = new Set(naive(b));
				const union = a.union(b);
				const both = a.intersect(b);
				const diff = a.subtract(b);
				expect(naive(union)).toEqual(sortedUnique([...sa, ...sb]));
				expect(naive(both)).toEqual(sortedUnique([...sa].filter((n) => sb.has(n))));
				expect(naive(diff)).toEqual(sortedUnique([...sa].filter((n) => !sb.has(n))));
				for (const set of [union, both, diff]) expect(wellFormed(set)).toBe(true);
			})
		);
	});

	it('agrees with a set of numbers under any sequence of adds and removes', () => {
		const op = fc.tuple(fc.boolean(), interval);
		fc.assert(
			fc.property(fc.array(op, { maxLength: 25 }), small, (ops, probe) => {
				let set = RangeSet.empty;
				const model = new Set<number>();
				for (const [add, { first, last }] of ops) {
					set = add ? set.add(first, last) : set.remove(first, last);
					for (let n = first; n <= last; n += 1) {
						if (add) model.add(n);
						else model.delete(n);
					}
				}
				expect(naive(set)).toEqual(sortedUnique(model));
				expect(set.size).toBe(model.size);
				expect(set.has(probe)).toBe(model.has(probe));
				expect(wellFormed(set)).toBe(true);
				expect(set.equals(RangeSet.fromNumbers(model))).toBe(true);
			})
		);
	});
});

describe('RangeMap', () => {
	const same = (a: string, b: string): boolean => a === b;
	const value = fc.constantFrom('a', 'b', 'c');

	it('changes only the keys it is asked to, and never adds keys', () => {
		fc.assert(
			fc.property(
				rangeSet,
				fc.array(fc.tuple(rangeSet, value), { maxLength: 10 }),
				small,
				(domain, updates, probe) => {
					let map = RangeMap.uniform<string>(domain, 'a', same);
					const model = new Map(naive(domain).map((n) => [n, 'a']));
					for (const [target, v] of updates) {
						map = map.set(target, v);
						for (const n of target.values()) if (model.has(n)) model.set(n, v);
					}
					expect(map.domain.equals(domain)).toBe(true);
					expect(map.size).toBe(model.size);
					expect(map.get(probe)).toBe(model.get(probe));
					for (const n of domain.values()) expect(map.get(n)).toBe(model.get(n));
					// Neighbouring segments always differ, so equal runs are one segment.
					map.segments.forEach((s, i) => {
						const next = map.segments[i + 1];
						if (next !== undefined && next.first === s.last + 1) {
							expect(next.value).not.toBe(s.value);
						}
					});
				}
			)
		);
	});

	it('finds the values of the segments overlapping an interval', () => {
		fc.assert(
			fc.property(
				rangeSet,
				fc.array(fc.tuple(rangeSet, value), { maxLength: 5 }),
				interval,
				(domain, updates, probe) => {
					let map = RangeMap.uniform<string>(domain, 'a', same);
					for (const [target, v] of updates) map = map.set(target, v);
					const expected = map.segments
						.filter((s) => s.first <= probe.last && s.last >= probe.first)
						.map((s) => s.value);
					expect(map.valuesOverlapping(probe.first, probe.last)).toEqual(expected);
				}
			)
		);
	});

	it('cuts segments down to a target', () => {
		fc.assert(
			fc.property(rangeSet, rangeSet, (domain, target) => {
				const map = RangeMap.uniform(domain, 'a', same);
				const pieces = map.within(target);
				expect(RangeSet.fromIntervals(pieces).equals(domain.intersect(target))).toBe(true);
			})
		);
	});

	it('keeps a uniform run as one segment however it is updated', () => {
		const map = RangeMap.uniform<string>(RangeSet.of(1, 1000), 'a', same)
			.set(RangeSet.of(10, 20), 'b')
			.set(RangeSet.of(10, 20), 'a');
		expect(map.segments).toEqual([{ first: 1, last: 1000, value: 'a' }]);
	});

	it('refuses overlapping segments', () => {
		expect(() =>
			RangeMap.fromSegments(
				[
					{ first: 1, last: 5, value: 'a' },
					{ first: 5, last: 6, value: 'b' }
				],
				same
			)
		).toThrow(RangeError);
	});
});
