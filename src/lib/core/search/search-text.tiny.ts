import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/**
 * Text a person searches for, as they typed it: plain text, never a pattern,
 * matched within one line at a time. Not empty, on one line, and at most
 * `MAX_SEARCH_CHARACTERS` long.
 */
export type SearchText = Tiny<string, 'SearchText'>;

/** The longest text that can be searched for: longer than any name or line a person would type. */
export const MAX_SEARCH_CHARACTERS = 500;

export type InvalidSearchTextReason = 'empty' | 'too-long' | 'several-lines' | 'nul-byte';

export interface InvalidSearchText {
	readonly kind: 'InvalidSearchText';
	readonly reason: InvalidSearchTextReason;
}

export function parseSearchText(value: string): Result<SearchText, InvalidSearchText> {
	if (value === '') return err({ kind: 'InvalidSearchText', reason: 'empty' });
	if (value.length > MAX_SEARCH_CHARACTERS) {
		return err({ kind: 'InvalidSearchText', reason: 'too-long' });
	}
	if (value.includes('\n')) return err({ kind: 'InvalidSearchText', reason: 'several-lines' });
	if (value.includes('\0')) return err({ kind: 'InvalidSearchText', reason: 'nul-byte' });
	return ok(value as SearchText);
}
