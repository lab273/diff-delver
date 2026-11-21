import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/** A number of branches, such as those whose name holds what a person typed. */
export type BranchCount = Tiny<number, 'BranchCount'>;

export interface InvalidBranchCount {
	readonly kind: 'InvalidBranchCount';
	readonly value: number;
}

/** Accepts zero or a positive whole number. */
export function parseBranchCount(value: number): Result<BranchCount, InvalidBranchCount> {
	if (!Number.isSafeInteger(value) || value < 0) return err({ kind: 'InvalidBranchCount', value });
	return ok(value as BranchCount);
}

/** A count the code has just made. A failure is a bug. */
export function branchCountOf(value: number): BranchCount {
	const parsed = parseBranchCount(value);
	if (!parsed.ok) throw new RangeError(`Not a count of branches: ${String(value)}`);
	return parsed.value;
}
