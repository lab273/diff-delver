import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A number of snapshots, such as those deleting a report removed. */
export type SnapshotCount = Tiny<number, 'SnapshotCount'>;

export interface InvalidSnapshotCount {
	readonly kind: 'InvalidSnapshotCount';
	readonly value: number;
}

/** Accepts zero or a positive whole number. */
export function parseSnapshotCount(value: number): Result<SnapshotCount, InvalidSnapshotCount> {
	if (!Number.isSafeInteger(value) || value < 0)
		return err({ kind: 'InvalidSnapshotCount', value });
	return ok(value as SnapshotCount);
}

/** A count the code has just made. A failure is a bug. */
export function snapshotCountOf(size: number): SnapshotCount {
	const parsed = parseSnapshotCount(size);
	if (!parsed.ok) throw new RangeError(`Not a count of snapshots: ${String(size)}`);
	return parsed.value;
}
