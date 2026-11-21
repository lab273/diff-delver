/**
 * Finding text a person searched for in a line, a path or a file's line
 * (DESIGN 8.3): plain text, never a pattern, found where it starts and as
 * many times as it occurs without overlapping, as a browser's find does.
 *
 * Without "Match case", the letters A to Z match a to z and nothing else is
 * folded, which is what git's own search does in diff delver's store (it runs
 * with C-locale settings), so searching the diff and the whole repository
 * finds the same things. Folding only those letters keeps every character at
 * its place, so a match's start and length are the same in the folded text
 * and in what is drawn.
 */
import type { SearchText } from './search-text.tiny.ts';

/** Where a match is in a text: its first character and its length, in UTF-16 code units. */
export interface TextMatch {
	readonly start: number;
	readonly length: number;
}

/** The text with A to Z as a to z, every other character as it is. */
export function foldCase(text: string): string {
	let folded = '';
	let from = 0;
	for (let at = 0; at < text.length; at += 1) {
		const code = text.charCodeAt(at);
		if (code >= 65 && code <= 90) {
			folded += text.slice(from, at) + String.fromCharCode(code + 32);
			from = at + 1;
		}
	}
	return from === 0 ? text : folded + text.slice(from);
}

/** The text as it is searched: folded unless case matters. */
export function searchedForm(text: string, matchCase: boolean): string {
	return matchCase ? text : foldCase(text);
}

/**
 * Every match of `query` in `text`, in order and not overlapping. `query` is
 * given as it is searched (`searchedForm`), so a long search folds it once.
 */
export function findIn(text: string, query: string, matchCase: boolean): readonly TextMatch[] {
	const haystack = searchedForm(text, matchCase);
	const found: TextMatch[] = [];
	for (
		let at = haystack.indexOf(query);
		at !== -1;
		at = haystack.indexOf(query, at + query.length)
	) {
		found.push({ start: at, length: query.length });
	}
	return found;
}

/** How many times `needle` occurs in `haystack`, not overlapping; both already in their searched form. */
export function occurrences(haystack: string, needle: string): number {
	let count = 0;
	for (
		let at = haystack.indexOf(needle);
		at !== -1;
		at = haystack.indexOf(needle, at + needle.length)
	) {
		count += 1;
	}
	return count;
}

/** How many times `query`, in its searched form, occurs in `text`, not overlapping. */
export function countIn(text: string, query: string, matchCase: boolean): number {
	return occurrences(searchedForm(text, matchCase), query);
}

/** What a search looks for, in its searched form. */
export function searchedQuery(query: SearchText, matchCase: boolean): string {
	return searchedForm(query, matchCase);
}
