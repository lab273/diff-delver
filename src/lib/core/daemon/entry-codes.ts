/**
 * The entry codes a daemon has given out and not yet seen used: kept in memory
 * only, each accepted once, within two minutes of being made. A daemon that
 * restarts forgets them, and its links say they are out of date.
 */
import type { Clock } from '../clock.ts';
import type { EntryCode } from '../entry-code.tiny.ts';

/** How long an entry code can be used for after it is made: two minutes. */
export const ENTRY_CODE_LIFETIME_MS = 120_000;

/** The same, as an address that works for that long says it. */
export const ENTRY_CODE_LIFETIME_TEXT = 'two minutes';

export interface EntryCodes {
	/** Records a new code, made by the caller, as usable from now. */
	issue(code: EntryCode): void;
	/** Whether `given` is a code that may be used now; using it means it never works again. */
	redeem(given: string): boolean;
}

export function entryCodes(clock: Clock): EntryCodes {
	const until = new Map<string, number>();
	return {
		issue(code) {
			const now = clock.now();
			for (const [old, end] of until) if (end <= now) until.delete(old);
			until.set(code, now + ENTRY_CODE_LIFETIME_MS);
		},
		redeem(given) {
			const end = until.get(given);
			until.delete(given);
			return end !== undefined && clock.now() < end;
		}
	};
}
