import type { Tiny } from './tiny.ts';

/** A number of `diff --git` sections in git's patch text. */
export type PatchCount = Tiny<number, 'PatchCount'>;

/** The size of a list of patches the code has just counted. A failure is a bug. */
export function patchCountOf(size: number): PatchCount {
	if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`Not a count: ${size}`);
	return size as PatchCount;
}
