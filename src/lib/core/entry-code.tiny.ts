import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * A single-use code that lets a browser in (DESIGN 9): 32 lowercase hex digits,
 * 128 random bits. The command asks the daemon for one and puts it in the
 * address it opens, in place of the daemon's long-lived token, which never
 * leaves the lockfile and the `Authorization` header. The daemon accepts a code
 * once, within `ENTRY_CODE_LIFETIME_MS` of making it (`daemon/entry-codes.ts`).
 */
export type EntryCode = Tiny<string, 'EntryCode'>;

export interface InvalidEntryCode {
	readonly kind: 'InvalidEntryCode';
}

export function parseEntryCode(value: string): Result<EntryCode, InvalidEntryCode> {
	if (!/^[0-9a-f]{32}$/.test(value)) return err({ kind: 'InvalidEntryCode' });
	return ok(value as EntryCode);
}
