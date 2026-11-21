/**
 * A long run of rows split into chunks the page draws one at a time, when each
 * comes near the screen, so a change of 80,000 rows shows its first rows at
 * once and never holds all of them before the reader scrolls to them.
 */

/** How many rows one chunk holds. */
export const ROWS_PER_CHUNK = 200;

/** One chunk: rows `first` to `end - 1`. */
export interface Chunk {
	readonly first: number;
	readonly end: number;
}

/** The chunks of `count` rows, in order, each but the last `size` long; none for no rows. */
export function chunksOf(count: number, size: number = ROWS_PER_CHUNK): readonly Chunk[] {
	const chunks: Chunk[] = [];
	for (let first = 0; first < count; first += size) {
		chunks.push({ first, end: Math.min(count, first + size) });
	}
	return chunks;
}
