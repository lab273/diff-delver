import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * One snapshot store in the data directory, which is one reviewed repository
 * (DESIGN 3.2). Also the store's directory name, so it is lowercase letters,
 * digits and hyphens, starting with a letter or digit, at most 80 characters.
 */
export type StoreId = Tiny<string, 'StoreId'>;

export interface InvalidStoreId {
	readonly kind: 'InvalidStoreId';
	readonly value: string;
}

export function parseStoreId(value: string): Result<StoreId, InvalidStoreId> {
	if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(value)) return err({ kind: 'InvalidStoreId', value });
	return ok(value as StoreId);
}
