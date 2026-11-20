/**
 * A map from whole numbers to values, stored as sorted, disjoint segments, each
 * an interval with one value. Adjacent segments with equal values are merged, so
 * a file whose 10,000 added lines all sit in one section is a single segment.
 *
 * The keys are fixed when the map is made (its domain); updates change values,
 * never keys. Immutable: every operation returns a new map.
 */
import { RangeSet, type Interval } from './range-set.ts';

export interface Segment<V> extends Interval {
	readonly value: V;
}

export class RangeMap<V> {
	readonly #segments: readonly Segment<V>[];
	readonly #equals: (a: V, b: V) => boolean;

	private constructor(segments: readonly Segment<V>[], equals: (a: V, b: V) => boolean) {
		this.#segments = segments;
		this.#equals = equals;
	}

	/** Every number of `domain` mapped to `value`. `equals` decides which segments merge. */
	static uniform<V>(domain: RangeSet, value: V, equals: (a: V, b: V) => boolean): RangeMap<V> {
		return new RangeMap(
			domain.intervals.map(({ first, last }) => ({ first, last, value })),
			equals
		);
	}

	/** A map from segments in any order. Overlapping segments are a programming error. */
	static fromSegments<V>(
		segments: Iterable<Segment<V>>,
		equals: (a: V, b: V) => boolean
	): RangeMap<V> {
		const sorted = [...segments].sort((a, b) => a.first - b.first);
		for (const [i, segment] of sorted.entries()) {
			const previous = sorted[i - 1];
			if (
				!Number.isSafeInteger(segment.first) ||
				!Number.isSafeInteger(segment.last) ||
				segment.first > segment.last ||
				(previous !== undefined && previous.last >= segment.first)
			) {
				throw new RangeError(`Bad or overlapping segment ${segment.first}..${segment.last}`);
			}
		}
		return new RangeMap(coalesce(sorted, equals), equals);
	}

	/** The segments, sorted; adjacent ones always differ in value. */
	get segments(): readonly Segment<V>[] {
		return this.#segments;
	}

	/** The keys. */
	get domain(): RangeSet {
		return RangeSet.fromIntervals(this.#segments);
	}

	/** How many keys the map has. */
	get size(): number {
		return this.#segments.reduce((sum, s) => sum + s.last - s.first + 1, 0);
	}

	get(n: number): V | undefined {
		let low = 0;
		let high = this.#segments.length - 1;
		while (low <= high) {
			const middle = (low + high) >> 1;
			const segment = this.#segments[middle];
			if (segment === undefined) return undefined;
			if (n < segment.first) high = middle - 1;
			else if (n > segment.last) low = middle + 1;
			else return segment.value;
		}
		return undefined;
	}

	/** The segments cut down to the keys in `target`. */
	within(target: RangeSet): readonly Segment<V>[] {
		const result: Segment<V>[] = [];
		forEachPiece(this.#segments, target, (piece, inside) => {
			if (inside) result.push(piece);
		});
		return result;
	}

	/** Replaces the value of every key in `target` with `f` of its value. Other keys keep theirs. */
	update(target: RangeSet, f: (value: V) => V): RangeMap<V> {
		if (target.isEmpty) return this;
		const pieces: Segment<V>[] = [];
		forEachPiece(this.#segments, target, (piece, inside) => {
			pieces.push(inside ? { ...piece, value: f(piece.value) } : piece);
		});
		return new RangeMap(coalesce(pieces, this.#equals), this.#equals);
	}

	/** Sets every key in `target` to `value`. */
	set(target: RangeSet, value: V): RangeMap<V> {
		return this.update(target, () => value);
	}
}

/**
 * Cuts the segments at the edges of `target` and calls `visit` for each piece in
 * order, saying whether the piece lies inside `target`.
 */
function forEachPiece<V>(
	segments: readonly Segment<V>[],
	target: RangeSet,
	visit: (piece: Segment<V>, inside: boolean) => void
): void {
	const cuts = target.intervals;
	let j = 0;
	for (const segment of segments) {
		let first = segment.first;
		while (j < cuts.length && (cuts[j]?.last ?? Infinity) < first) j += 1;
		let k = j;
		while (first <= segment.last) {
			const cut = cuts[k];
			if (cut === undefined || cut.first > segment.last) {
				visit({ first, last: segment.last, value: segment.value }, false);
				break;
			}
			if (cut.first > first) {
				visit({ first, last: cut.first - 1, value: segment.value }, false);
				first = cut.first;
			}
			const last = Math.min(cut.last, segment.last);
			visit({ first, last, value: segment.value }, true);
			first = last + 1;
			if (cut.last <= segment.last) k += 1;
		}
	}
}

function coalesce<V>(
	segments: readonly Segment<V>[],
	equals: (a: V, b: V) => boolean
): readonly Segment<V>[] {
	const result: Segment<V>[] = [];
	for (const segment of segments) {
		const previous = result.at(-1);
		if (
			previous !== undefined &&
			previous.last + 1 === segment.first &&
			equals(previous.value, segment.value)
		) {
			result[result.length - 1] = {
				first: previous.first,
				last: segment.last,
				value: previous.value
			};
		} else {
			result.push(segment);
		}
	}
	return result;
}
