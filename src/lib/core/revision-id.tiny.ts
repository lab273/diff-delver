import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * A revision of a report (DESIGN 6.2): `v_` and 1 to 32 lowercase letters or
 * digits. Unique across reports; within one report a revision is also known by
 * its `RevisionNumber`. Made by an id source (`ids.ts`).
 */
export type RevisionId = Tiny<string, 'RevisionId'>;

export interface InvalidRevisionId {
	readonly kind: 'InvalidRevisionId';
	readonly value: string;
}

export function parseRevisionId(value: string): Result<RevisionId, InvalidRevisionId> {
	if (!/^v_[0-9a-z]{1,32}$/.test(value)) return err({ kind: 'InvalidRevisionId', value });
	return ok(value as RevisionId);
}
