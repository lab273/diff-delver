/**
 * A set of whole numbers stored as sorted, disjoint, non-adjacent intervals, so a
 * run of a million consecutive line numbers costs one entry. Immutable: every
 * operation returns a new set.
 *
 * This is a general utility over plain integers. The diff model wraps what it
 * reads back out in tiny types such as `LineRange`.
 */

/** An inclusive interval of whole numbers, `first` to `last`. */
export interface Interval {
	readonly first: number;
	readonly last: number;
}

function checkInterval(first: number, last: number): void {
	if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last) {
		throw new RangeError(`Not an interval of whole numbers: ${first}..${last}`);
	}
}

export class RangeSet {
	static readonly empty: RangeSet = new RangeSet([]);

	readonly #intervals: readonly Interval[];
	#size: number | undefined;

	/** Takes intervals that are already sorted, disjoint and non-adjacent. */
	private constructor(intervals: readonly Interval[]) {
		this.#intervals = intervals;
	}

	/** The set `first..last`, inclusive. */
	static of(first: number, last: number = first): RangeSet {
		checkInterval(first, last);
		return new RangeSet([{ first, last }]);
	}

	/** The union of any intervals, in any order, overlapping or not. */
	static fromIntervals(intervals: Iterable<Interval>): RangeSet {
		const sorted = [...intervals].sort((a, b) => a.first - b.first);
		const merged: Interval[] = [];
		for (const { first, last } of sorted) {
			checkInterval(first, last);
			const previous = merged.at(-1);
			if (previous !== undefined && first <= previous.last + 1) {
				if (last > previous.last) merged[merged.length - 1] = { first: previous.first, last };
			} else {
				merged.push({ first, last });
			}
		}
		return new RangeSet(merged);
	}

	static fromNumbers(numbers: Iterable<number>): RangeSet {
		return RangeSet.fromIntervals([...numbers].map((n) => ({ first: n, last: n })));
	}

	/** The intervals, sorted, disjoint and non-adjacent. */
	get intervals(): readonly Interval[] {
		return this.#intervals;
	}

	/** How many numbers are in the set. */
	get size(): number {
		this.#size ??= this.#intervals.reduce((sum, i) => sum + i.last - i.first + 1, 0);
		return this.#size;
	}

	get isEmpty(): boolean {
		return this.#intervals.length === 0;
	}

	get min(): number | undefined {
		return this.#intervals[0]?.first;
	}

	get max(): number | undefined {
		return this.#intervals.at(-1)?.last;
	}

	has(n: number): boolean {
		let low = 0;
		let high = this.#intervals.length - 1;
		while (low <= high) {
			const middle = (low + high) >> 1;
			const interval = this.#intervals[middle];
			if (interval === undefined) return false;
			if (n < interval.first) high = middle - 1;
			else if (n > interval.last) low = middle + 1;
			else return true;
		}
		return false;
	}

	/**
	 * The index in `intervals` of the first interval that ends at or after `n`,
	 * or the number of intervals when none does. Found by binary search.
	 */
	firstEndingAtOrAfter(n: number): number {
		let low = 0;
		let high = this.#intervals.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((this.#intervals[middle]?.last ?? n) < n) low = middle + 1;
			else high = middle;
		}
		return low;
	}

	/** Whether any number from `first` to `last` is in the set. */
	overlaps(first: number, last: number): boolean {
		const interval = this.#intervals[this.firstEndingAtOrAfter(first)];
		return interval !== undefined && interval.first <= last;
	}

	union(other: RangeSet): RangeSet {
		if (other.isEmpty) return this;
		if (this.isEmpty) return other;
		return RangeSet.fromIntervals([...this.#intervals, ...other.#intervals]);
	}

	intersect(other: RangeSet): RangeSet {
		const result: Interval[] = [];
		let i = 0;
		let j = 0;
		const a = this.#intervals;
		const b = other.#intervals;
		while (i < a.length && j < b.length) {
			const x = a[i];
			const y = b[j];
			if (x === undefined || y === undefined) break;
			const first = Math.max(x.first, y.first);
			const last = Math.min(x.last, y.last);
			if (first <= last) result.push({ first, last });
			if (x.last < y.last) i += 1;
			else j += 1;
		}
		return new RangeSet(result);
	}

	subtract(other: RangeSet): RangeSet {
		if (this.isEmpty || other.isEmpty) return this;
		const result: Interval[] = [];
		let j = 0;
		const b = other.#intervals;
		for (const interval of this.#intervals) {
			let first = interval.first;
			const last = interval.last;
			while (j < b.length && (b[j]?.last ?? Infinity) < first) j += 1;
			let k = j;
			while (first <= last) {
				const cut = b[k];
				if (cut === undefined || cut.first > last) {
					result.push({ first, last });
					break;
				}
				if (cut.first > first) result.push({ first, last: cut.first - 1 });
				first = Math.max(first, cut.last + 1);
				k += 1;
			}
		}
		return new RangeSet(result);
	}

	add(first: number, last: number = first): RangeSet {
		return this.union(RangeSet.of(first, last));
	}

	remove(first: number, last: number = first): RangeSet {
		return this.subtract(RangeSet.of(first, last));
	}

	equals(other: RangeSet): boolean {
		const a = this.#intervals;
		const b = other.#intervals;
		return (
			a.length === b.length &&
			a.every((x, i) => {
				const y = b[i];
				return y !== undefined && x.first === y.first && x.last === y.last;
			})
		);
	}

	/** Every number in the set, in order. */
	*values(): IterableIterator<number> {
		for (const { first, last } of this.#intervals) {
			for (let n = first; n <= last; n += 1) yield n;
		}
	}
}
