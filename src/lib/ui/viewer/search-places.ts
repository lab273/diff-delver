/**
 * Where a search's matches are in one part the page has fetched, in the order
 * the page draws them (`core/search/diff-search.ts` says what is read): its
 * path, then each block in turn: the lines opened above and below unchanged
 * lines still hidden, and the lines of its own hunks. Hunks of other groups,
 * folded away, are not read. The daemon counts the same matches, but for the
 * opened lines, which only the page knows.
 */
import type { ShownLineView } from '#lib/api/schemas.ts';
import { findIn } from '#lib/core/search/find-text.ts';
import { readsLine, type DiffSearchOptions } from '#lib/core/search/diff-search.ts';
import type { BlockState, OpenLine } from './viewer.svelte.ts';

/** Where a match is in a part. */
export type MatchPlace =
	| { readonly kind: 'path'; readonly start: number; readonly length: number }
	| {
			readonly kind: 'line';
			/** The block it is in, by its place in the part's blocks. */
			readonly block: number;
			/** The line it is on, as the page holds it. */
			readonly line: ShownLineView | OpenLine;
			/** An opened unchanged line, which only the page counts. */
			readonly opened: boolean;
			readonly start: number;
			readonly length: number;
	  };

/**
 * The matches of `query`, in its searched form, in a part with this shown
 * path and these blocks (none when its lines have not been fetched).
 */
export function placesIn(
	path: string,
	blocks: readonly BlockState[] | undefined,
	query: string,
	options: DiffSearchOptions
): readonly MatchPlace[] {
	const places: MatchPlace[] = [];
	for (const m of findIn(path, query, options.matchCase)) places.push({ kind: 'path', ...m });
	if (blocks === undefined) return places;
	const inLine = (block: number, line: ShownLineView | OpenLine, opened: boolean): void => {
		for (const m of findIn(line.text, query, options.matchCase)) {
			places.push({ kind: 'line', block, line, opened, ...m });
		}
	};
	for (const [b, block] of blocks.entries()) {
		switch (block.kind) {
			case 'hidden':
				if (options.changedOnly) break;
				for (const line of block.top) inLine(b, line, true);
				for (const line of block.bottom) inLine(b, line, true);
				break;
			case 'hunk':
				for (const line of block.lines) {
					if (readsLine(line.kind !== 'context', options)) inLine(b, line, false);
				}
				break;
			case 'elsewhere':
				break;
		}
	}
	return places;
}

/** How many matches of `query` are in the unchanged lines a part has opened. */
export function openedMatches(
	blocks: readonly BlockState[],
	query: string,
	options: DiffSearchOptions
): number {
	if (options.changedOnly) return 0;
	let count = 0;
	for (const block of blocks) {
		if (block.kind !== 'hidden') continue;
		for (const line of [...block.top, ...block.bottom]) {
			count += findIn(line.text, query, options.matchCase).length;
		}
	}
	return count;
}
