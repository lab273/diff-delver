import { isObjectId } from './object-id.ts';
import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A git tree object id: the contents of a directory at one moment. */
export type TreeId = Tiny<string, 'TreeId'>;

export interface InvalidTreeId {
	readonly kind: 'InvalidTreeId';
	readonly value: string;
}

/** Accepts a full SHA-1 or SHA-256 object id in lowercase hex. */
export function parseTreeId(value: string): Result<TreeId, InvalidTreeId> {
	if (!isObjectId(value)) return err({ kind: 'InvalidTreeId', value });
	return ok(value as TreeId);
}
