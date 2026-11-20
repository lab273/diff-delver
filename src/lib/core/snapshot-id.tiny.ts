import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * A snapshot in a store (DESIGN 3.2): 32 lowercase hex digits, made at random when
 * the snapshot is taken. Unique within its store; the store's ref is named by it.
 */
export type SnapshotId = Tiny<string, 'SnapshotId'>;

export interface InvalidSnapshotId {
	readonly kind: 'InvalidSnapshotId';
	readonly value: string;
}

export function parseSnapshotId(value: string): Result<SnapshotId, InvalidSnapshotId> {
	if (!/^[0-9a-f]{32}$/.test(value)) return err({ kind: 'InvalidSnapshotId', value });
	return ok(value as SnapshotId);
}
