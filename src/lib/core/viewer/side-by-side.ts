/**
 * A part's lines side by side (DESIGN 8.3), paired as GitHub pairs them: an
 * unchanged line is beside itself; in each run of changes, the removed lines,
 * in order, are beside the added lines that replace them, in order, the first
 * beside the first; when one side has more, its extra lines are beside an
 * empty cell. Nothing is left out or repeated, and each side keeps its order,
 * so reading either column down gives that side of the unified view.
 *
 * Generic over the line, so the page pairs its own lines: `sideOf` says
 * whether a line is on both sides (unchanged), only the old (removed) or only
 * the new (added).
 */

export type LineSide = 'both' | 'old' | 'new';

/** One row: the line on each side, the same line on both for an unchanged one. */
export interface SideRow<T> {
	readonly old: T | undefined;
	readonly new: T | undefined;
}

export function sideBySide<T>(
	lines: readonly T[],
	sideOf: (line: T) => LineSide
): readonly SideRow<T>[] {
	const rows: SideRow<T>[] = [];
	let old: T[] = [];
	let now: T[] = [];
	const flush = (): void => {
		for (let i = 0; i < Math.max(old.length, now.length); i += 1) {
			rows.push({ old: old[i], new: now[i] });
		}
		old = [];
		now = [];
	};
	for (const line of lines) {
		switch (sideOf(line)) {
			case 'both':
				flush();
				rows.push({ old: line, new: line });
				break;
			case 'old':
				// A removed line after added ones starts a new run, so no line moves above another of its side.
				if (now.length > 0) flush();
				old.push(line);
				break;
			case 'new':
				now.push(line);
				break;
		}
	}
	flush();
	return rows;
}
