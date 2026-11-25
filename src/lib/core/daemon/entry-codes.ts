/**
 * The entry codes a daemon has given out and not yet seen used: kept in memory
 * only, each accepted once, however long after it was made. A daemon that
 * restarts forgets them, and its links say they are out of date. Past
 * `MOST_ENTRY_CODES_KEPT` unused codes, the oldest is forgotten.
 */
import type { EntryCode } from '../entry-code.tiny.ts';

/** How many unused entry codes a daemon keeps; making one more forgets the oldest. */
export const MOST_ENTRY_CODES_KEPT = 1000;

export type BrowserGrant = 'view' | 'review';

export interface EntryCodes {
	/** Records a new code, made by the caller, as usable from now. */
	issue(code: EntryCode, grant: BrowserGrant): void;
	/** Whether `given` is a code that may be used now; using it means it never works again. */
	redeem(given: string): BrowserGrant | undefined;
}

export function entryCodes(): EntryCodes {
	// A Map iterates in the order its keys were set, so the first key is the oldest.
	const codes = new Map<string, BrowserGrant>();
	return {
		issue(code, grant) {
			codes.delete(code);
			codes.set(code, grant);
			for (const old of codes.keys()) {
				if (codes.size <= MOST_ENTRY_CODES_KEPT) break;
				codes.delete(old);
			}
		},
		redeem(given) {
			const found = codes.get(given);
			codes.delete(given);
			return found;
		}
	};
}
