import type { BlobId } from './blob-id.tiny.ts';
import type { CommitId } from './commit-id.tiny.ts';
import { isObjectId } from './object-id.ts';
import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';
import type { TreeId } from './tree-id.tiny.ts';

/** A git object id whose type is not known: a blob, tree, commit or tag. */
export type ObjectId = Tiny<string, 'ObjectId'>;

/** Any git object id, of a known type or not, as a command that takes object ids accepts. */
export type AnyObjectId = ObjectId | BlobId | TreeId | CommitId;

export interface InvalidObjectId {
	readonly kind: 'InvalidObjectId';
	readonly value: string;
}

/** Accepts a full SHA-1 or SHA-256 object id in lowercase hex. */
export function parseObjectId(value: string): Result<ObjectId, InvalidObjectId> {
	if (!isObjectId(value)) return err({ kind: 'InvalidObjectId', value });
	return ok(value as ObjectId);
}
