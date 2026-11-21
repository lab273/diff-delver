/**
 * Hiding changes that only change white space (DESIGN 8.3), as a way of
 * looking: the changes are still changes, counted and ticked as before; they
 * are only drawn as unchanged lines.
 *
 * The rule, as other tools have it (`git diff -w`, GitHub's "Hide
 * whitespace"):
 *
 * - White space here is the space, the tab, the carriage return, the form
 *   feed and the vertical tab, wherever they are in a line: indentation,
 *   between words, inside a string, at the end, and a CRLF line ending.
 *   Other characters that look blank (a no-break space, a zero-width space)
 *   are not white space for this rule, so a change to one is never hidden.
 * - A removed line and an added line are the same apart from white space
 *   when they are equal once all of it is taken out.
 * - Lines are matched within one run of changes (the removed and added lines
 *   between two unchanged ones): each removed line, in order, with the first
 *   added line after the one matched last that is the same apart from white
 *   space and belongs to the same group. So a re-indented block matches line
 *   for line, and no line is matched across another that was matched.
 * - Each matched pair is drawn as one unchanged line. A removed or added
 *   line that matched nothing is drawn as a change, as before, even a blank
 *   line added on its own.
 * - A change to a file itself (a rename, a mode) is never hidden: it is no
 *   line.
 */

/** The text with every white-space character of the rule taken out. */
export function withoutWhiteSpace(text: string): string {
	return text.replace(/[ \t\r\f\v]/g, '');
}

/** What the rule needs to know of a line. */
export interface LineForWhiteSpace {
	readonly kind: 'context' | 'deleted' | 'added';
	readonly text: string;
	/** Which group the change belongs to, as text; two lines match only within one. */
	readonly group: string;
}

/** A line drawn as it is, or a removed and an added line drawn as one unchanged line. */
export type Quieted<T> =
	| { readonly kind: 'line'; readonly line: T }
	| { readonly kind: 'quiet'; readonly removed: T; readonly added: T };

/** The first entry of a sorted list greater than `after`, by halving. */
function firstAfter(sorted: readonly number[], after: number): number | undefined {
	let low = 0;
	let high = sorted.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((sorted[middle] ?? 0) > after) high = middle;
		else low = middle + 1;
	}
	return sorted[low];
}

/** One run of changes, with its matched pairs drawn as unchanged lines. */
function quietRun<T>(
	run: readonly T[],
	view: (line: T) => LineForWhiteSpace,
	out: Quieted<T>[]
): void {
	const removed = run.filter((l) => view(l).kind === 'deleted');
	const added = run.filter((l) => view(l).kind === 'added');
	const keyOf = (line: T): string => {
		const v = view(line);
		return `${v.group}\u0000${withoutWhiteSpace(v.text)}`;
	};
	const addedAt = new Map<string, number[]>();
	for (const [i, line] of added.entries()) {
		const key = keyOf(line);
		const list = addedAt.get(key);
		if (list === undefined) addedAt.set(key, [i]);
		else list.push(i);
	}
	const pairs: (readonly [number, number])[] = [];
	let after = -1;
	for (const [i, line] of removed.entries()) {
		const match = firstAfter(addedAt.get(keyOf(line)) ?? [], after);
		if (match === undefined) continue;
		pairs.push([i, match]);
		after = match;
	}
	if (pairs.length === 0) {
		for (const line of run) out.push({ kind: 'line', line });
		return;
	}
	// Each pair comes after the unmatched removed and added lines before it, in order.
	let r = 0;
	let a = 0;
	for (const [ri, ai] of pairs) {
		for (; r < ri; r += 1) {
			const line = removed[r];
			if (line !== undefined) out.push({ kind: 'line', line });
		}
		for (; a < ai; a += 1) {
			const line = added[a];
			if (line !== undefined) out.push({ kind: 'line', line });
		}
		const pairRemoved = removed[ri];
		const pairAdded = added[ai];
		if (pairRemoved !== undefined && pairAdded !== undefined) {
			out.push({ kind: 'quiet', removed: pairRemoved, added: pairAdded });
		}
		r = ri + 1;
		a = ai + 1;
	}
	for (const line of removed.slice(r)) out.push({ kind: 'line', line });
	for (const line of added.slice(a)) out.push({ kind: 'line', line });
}

/**
 * A hunk's lines with every change that only changes white space drawn as an
 * unchanged line, by the rule above. `view` says what the rule needs of a line.
 */
export function quietWhiteSpace<T>(
	lines: readonly T[],
	view: (line: T) => LineForWhiteSpace
): readonly Quieted<T>[] {
	const out: Quieted<T>[] = [];
	let run: T[] = [];
	for (const line of lines) {
		if (view(line).kind === 'context') {
			if (run.length > 0) quietRun(run, view, out);
			run = [];
			out.push({ kind: 'line', line });
		} else run.push(line);
	}
	if (run.length > 0) quietRun(run, view, out);
	return out;
}
