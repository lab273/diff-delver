import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/** A number of commits, such as those a branch has that the main branch lacks. */
export type CommitCount = Tiny<number, 'CommitCount'>;

export interface InvalidCommitCount {
	readonly kind: 'InvalidCommitCount';
	readonly value: number;
}

/** Accepts zero or a positive whole number. */
export function parseCommitCount(value: number): Result<CommitCount, InvalidCommitCount> {
	if (!Number.isSafeInteger(value) || value < 0) return err({ kind: 'InvalidCommitCount', value });
	return ok(value as CommitCount);
}

/** A count the code has just made. A failure is a bug. */
export function commitCountOf(value: number): CommitCount {
	const parsed = parseCommitCount(value);
	if (!parsed.ok) throw new RangeError(`Not a count of commits: ${String(value)}`);
	return parsed.value;
}
