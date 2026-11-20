import { isObjectId } from './object-id.ts';
import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A git commit object id. */
export type CommitId = Tiny<string, 'CommitId'>;

export interface InvalidCommitId {
	readonly kind: 'InvalidCommitId';
	readonly value: string;
}

/** Accepts a full SHA-1 or SHA-256 object id in lowercase hex. */
export function parseCommitId(value: string): Result<CommitId, InvalidCommitId> {
	if (!isObjectId(value)) return err({ kind: 'InvalidCommitId', value });
	return ok(value as CommitId);
}
