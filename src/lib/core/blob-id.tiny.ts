import { isObjectId } from './object-id.ts';
import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A git blob object id: the contents of one file. */
export type BlobId = Tiny<string, 'BlobId'>;

export interface InvalidBlobId {
	readonly kind: 'InvalidBlobId';
	readonly value: string;
}

/** Accepts a full SHA-1 or SHA-256 object id in lowercase hex. */
export function parseBlobId(value: string): Result<BlobId, InvalidBlobId> {
	if (!isObjectId(value)) return err({ kind: 'InvalidBlobId', value });
	return ok(value as BlobId);
}
