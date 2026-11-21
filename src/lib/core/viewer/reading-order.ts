/**
 * Moving through a diff's parts in reading order (DESIGN 1.1 commitment 4,
 * 8.1): the next part that still waits for the reviewer, from wherever they
 * are, going round to the top; the one before; and what "only what I have not
 * reviewed" leaves on the page.
 *
 * Positions are places in the page's list of parts, in reading order; which
 * parts wait is given as one flag per part, so the page and the tests use the
 * same rule (`needsReview` in `parts.ts`).
 */

/**
 * The next part after `from` that waits, going round past the end to the top
 * and back to `from` itself last; with `from` undefined, the first that waits.
 * Undefined when none does.
 */
export function nextWaiting(waiting: readonly boolean[], from?: number): number | undefined {
	const count = waiting.length;
	if (count === 0) return undefined;
	const start = from === undefined ? -1 : from;
	for (let step = 1; step <= count; step += 1) {
		const at = (((start + step) % count) + count) % count;
		if (waiting[at] === true) return at;
	}
	return undefined;
}

/** The part before `from` that waits, going round past the top to the end; like `nextWaiting`. */
export function previousWaiting(waiting: readonly boolean[], from?: number): number | undefined {
	const count = waiting.length;
	if (count === 0) return undefined;
	const start = from === undefined ? count : from;
	for (let step = 1; step <= count; step += 1) {
		const at = (((start - step) % count) + count) % count;
		if (waiting[at] === true) return at;
	}
	return undefined;
}

/** The part after `from` (or the first), whether it waits or not, stopping at the end. */
export function nextPart(count: number, from?: number): number | undefined {
	const at = from === undefined ? 0 : from + 1;
	return at < count ? at : undefined;
}

/** The part before `from` (or the last), stopping at the top. */
export function previousPart(count: number, from?: number): number | undefined {
	const at = from === undefined ? count - 1 : from - 1;
	return at >= 0 && at < count ? at : undefined;
}

/**
 * Which parts the page shows: every one, or with "only what I have not
 * reviewed" those that still wait. A part with lines new since the previous
 * version waits until they are marked, so it stays.
 */
export function shownParts(waiting: readonly boolean[], onlyWaiting: boolean): readonly number[] {
	const shown: number[] = [];
	for (const [at, waits] of waiting.entries()) if (!onlyWaiting || waits) shown.push(at);
	return shown;
}
