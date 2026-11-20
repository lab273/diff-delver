import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * A section's id, chosen by the agent: a short slug such as `session-expiry`.
 * Lowercase letters and digits, joined by single `-`, `_` or `.`; at most 64
 * characters. `ignored` and `uncategorised` are not section ids: they name the
 * other two buckets.
 */
export type SectionId = Tiny<string, 'SectionId'>;

export type InvalidSectionIdReason = 'empty' | 'too-long' | 'not-a-slug' | 'reserved';

export interface InvalidSectionId {
	readonly kind: 'InvalidSectionId';
	readonly value: string;
	readonly reason: InvalidSectionIdReason;
}

const MAX_LENGTH = 64;
const SLUG = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const RESERVED: ReadonlySet<string> = new Set(['ignored', 'uncategorised', 'uncategorized']);

export function parseSectionId(value: string): Result<SectionId, InvalidSectionId> {
	const reason = problem(value);
	if (reason !== undefined) return err({ kind: 'InvalidSectionId', value, reason });
	return ok(value as SectionId);
}

function problem(value: string): InvalidSectionIdReason | undefined {
	if (value === '') return 'empty';
	if (value.length > MAX_LENGTH) return 'too-long';
	if (!SLUG.test(value)) return 'not-a-slug';
	if (RESERVED.has(value)) return 'reserved';
	return undefined;
}
