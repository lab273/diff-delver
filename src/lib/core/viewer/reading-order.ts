/**
 * Moving through a diff's parts in reading order (DESIGN 1.1 commitment 4,
 * 8.1): the next part that still waits for the reviewer, from wherever they
 * are, going round to the top; the one before; the next and previous part the
 * page shows; and what "only what I have not reviewed" leaves on the page.
 *
 * Positions are places in the page's list of parts, in reading order; which
 * parts wait, or are shown, is given as one flag per part, so the page and the
 * tests use the same rule (`needsReview` in `parts.ts`).
 */
import { partIndexOf, type PartIndex } from '../part-index.tiny.ts';

/**
 * The next part after `from` that waits, going round past the end to the top
 * and back to `from` itself last; with `from` undefined, the first that waits.
 * Undefined when none does.
 */
export function nextWaiting(waiting: readonly boolean[], from?: PartIndex): PartIndex | undefined {
	const count = waiting.length;
	if (count === 0) return undefined;
	const start = from === undefined ? -1 : from;
	for (let step = 1; step <= count; step += 1) {
		const at = (((start + step) % count) + count) % count;
		if (waiting[at] === true) return partIndexOf(at);
	}
	return undefined;
}

/** The part before `from` that waits, going round past the top to the end; like `nextWaiting`. */
export function previousWaiting(
	waiting: readonly boolean[],
	from?: PartIndex
): PartIndex | undefined {
	const count = waiting.length;
	if (count === 0) return undefined;
	const start = from === undefined ? count : from;
	for (let step = 1; step <= count; step += 1) {
		const at = (((start - step) % count) + count) % count;
		if (waiting[at] === true) return partIndexOf(at);
	}
	return undefined;
}

/**
 * The next part the page shows after `from`, stopping at the end; with `from`
 * undefined, the first shown. `from` need not be shown itself: a part just
 * ticked under "only what I have not reviewed" has gone from the page, and
 * moving on from it goes to the part shown after where it was.
 */
export function nextShown(shown: readonly boolean[], from?: PartIndex): PartIndex | undefined {
	for (let at = from === undefined ? 0 : from + 1; at < shown.length; at += 1) {
		if (shown[at] === true) return partIndexOf(at);
	}
	return undefined;
}

/** The part the page shows before `from`, stopping at the top; with `from` undefined, the last shown. */
export function previousShown(shown: readonly boolean[], from?: PartIndex): PartIndex | undefined {
	for (let at = (from === undefined ? shown.length : from) - 1; at >= 0; at -= 1) {
		if (shown[at] === true) return partIndexOf(at);
	}
	return undefined;
}

/**
 * Which parts the page shows: every one, or with "only what I have not
 * reviewed" those that still wait. A part with lines new since the previous
 * version waits until they are marked, so it stays.
 */
export function shownParts(waiting: readonly boolean[], onlyWaiting: boolean): readonly boolean[] {
	return waiting.map((waits) => !onlyWaiting || waits);
}
