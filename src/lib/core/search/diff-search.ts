/**
 * Searching within a diff (DESIGN 8.3): what a search reads of each part, and
 * how its matches are counted, the same in the daemon, which has every line,
 * and on the page, which has only the parts it has fetched.
 *
 * - A part's path, as the page shows it (`shown-path.tiny.ts`), is searched.
 * - So is every line of its hunks as the page draws them: unchanged lines,
 *   its own changes, and the changes of other groups shown muted among them.
 *   A hunk holding none of the part's changes is not: it is folded away on
 *   the page and its lines are searched in their own part.
 * - With "changed lines only", unchanged lines are left out.
 * - Lines a person has opened around a change are unchanged lines the page
 *   shows; the page counts them itself, since only it knows which are open.
 *
 * A change that only changes white space is searched as git has it, whether
 * or not the page draws it as an unchanged line: its matches are counted, and
 * moving to one shows that hunk's white-space changes.
 */
import type { PartBlock } from '../viewer/part-lines.ts';
import { countIn, foldCase, occurrences, searchedQuery } from './find-text.ts';
import { matchCountOf, type MatchCount } from './match-count.tiny.ts';
import type { SearchText } from './search-text.tiny.ts';

/** How a search of the diff reads it: the person's options. */
export interface DiffSearchOptions {
	/** Upper and lower case are told apart. */
	readonly matchCase: boolean;
	/** Only added and removed lines, and paths, are searched. */
	readonly changedOnly: boolean;
}

/** A line as the search reads it. */
export interface SearchedLine {
	readonly text: string;
	/** An added or removed line, rather than an unchanged one. */
	readonly changed: boolean;
}

/** What a search reads of one part. */
export interface SearchedPart {
	/** Its path as the page shows it. */
	readonly path: string;
	/** The lines of its hunks, in order. */
	readonly lines: readonly SearchedLine[];
}

/** The lines of a part's blocks a search reads: those of its own hunks, in order. */
export function searchedLines(blocks: readonly PartBlock[]): readonly SearchedLine[] {
	const lines: SearchedLine[] = [];
	for (const block of blocks) {
		if (block.kind !== 'hunk') continue;
		for (const line of block.lines) {
			lines.push({ text: line.line.text, changed: line.kind !== 'context' });
		}
	}
	return lines;
}

/** Whether the search reads a line, with the options given. */
export function readsLine(changed: boolean, options: DiffSearchOptions): boolean {
	return changed || !options.changedOnly;
}

/** How many matches a part has: in its path, and in the lines the search reads. */
export function countInPart(
	part: SearchedPart,
	query: SearchText,
	options: DiffSearchOptions
): MatchCount {
	const wanted = searchedQuery(query, options.matchCase);
	let count = countIn(part.path, wanted, options.matchCase);
	for (const line of part.lines) {
		if (readsLine(line.changed, options)) count += countIn(line.text, wanted, options.matchCase);
	}
	return matchCountOf(count);
}

/**
 * Every part of a diff as a search reads it, in reading order, ready to be
 * searched again and again as a person types: each text is folded for a
 * search that ignores case once, the first time one is made.
 */
export class DiffSearchIndex {
	readonly #parts: readonly SearchedPart[];
	#folded: readonly { readonly path: string; readonly lines: readonly string[] }[] | undefined;

	constructor(parts: readonly SearchedPart[]) {
		this.#parts = parts;
	}

	/** How many parts it holds. */
	get size(): number {
		return this.#parts.length;
	}

	#foldedParts(): readonly { readonly path: string; readonly lines: readonly string[] }[] {
		this.#folded ??= this.#parts.map((part) => ({
			path: foldCase(part.path),
			lines: part.lines.map((line) => foldCase(line.text))
		}));
		return this.#folded;
	}

	/** Each part's matches, in reading order; the same as `countInPart` gives for each. */
	counts(query: SearchText, options: DiffSearchOptions): readonly MatchCount[] {
		const wanted = searchedQuery(query, options.matchCase);
		const folded = options.matchCase ? undefined : this.#foldedParts();
		return this.#parts.map((part, p) => {
			const texts = folded?.[p];
			let count = occurrences(texts?.path ?? part.path, wanted);
			for (const [i, line] of part.lines.entries()) {
				if (!readsLine(line.changed, options)) continue;
				count += occurrences(texts?.lines[i] ?? line.text, wanted);
			}
			return matchCountOf(count);
		});
	}
}
