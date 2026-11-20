import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * A hunk's id within one file's diff: `h1`, `h2` and so on in order. Stable for a
 * snapshot, because the diff of two fixed trees does not change.
 */
export type HunkId = Tiny<string, 'HunkId'>;

export interface InvalidHunkId {
	readonly kind: 'InvalidHunkId';
	readonly value: string;
}

export function parseHunkId(value: string): Result<HunkId, InvalidHunkId> {
	if (!/^h[1-9][0-9]*$/.test(value)) return err({ kind: 'InvalidHunkId', value });
	return ok(value as HunkId);
}

/** The id of the hunk at a 0-based position in its file. */
export function hunkIdAt(index: number): HunkId {
	if (!Number.isSafeInteger(index) || index < 0) {
		throw new RangeError(`A hunk position must be a whole number from 0, not ${index}`);
	}
	return `h${String(index + 1)}` as HunkId;
}
