import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * A fingerprint of a source's current state, for noticing that it has changed
 * without taking a snapshot (DESIGN 6.2): 64 lowercase hex digits. Two equal
 * identities of one source mean a snapshot would very likely be the same; see
 * `sourceIdentity` for when it can be wrong.
 */
export type SourceIdentity = Tiny<string, 'SourceIdentity'>;

export interface InvalidSourceIdentity {
	readonly kind: 'InvalidSourceIdentity';
	readonly value: string;
}

export function parseSourceIdentity(value: string): Result<SourceIdentity, InvalidSourceIdentity> {
	if (!/^[0-9a-f]{64}$/.test(value)) return err({ kind: 'InvalidSourceIdentity', value });
	return ok(value as SourceIdentity);
}
