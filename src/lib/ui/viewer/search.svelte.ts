/**
 * Searching within the diff from its page (DESIGN 8.3): the search box's text
 * and options, what the daemon found (how many matches each part has, across
 * the whole diff, never only the parts drawn), which match the person is on,
 * and what moving to matches opened, so closing the search puts it all back.
 *
 * Typing never moves the reader: matches are counted and marked as the person
 * types, and Enter, or Next, goes to the next one. Moving to a match opens its
 * part when it is closed, shows a large change, and shows a hunk's white-space
 * changes when the match is in one drawn as an unchanged line.
 *
 * What is counted follows the page: parts the filter hides are not, nor, with
 * "Skip closed files", parts that are closed; lines opened around a change are.
 */
import { describeApiError } from '#lib/api/client.ts';
import type { DiffSearchView } from '#lib/api/schemas.ts';
import { partIndexOf, type PartIndex } from '#lib/core/part-index.tiny.ts';
import type { DiffSearchOptions } from '#lib/core/search/diff-search.ts';
import { searchedQuery } from '#lib/core/search/find-text.ts';
import type { Mark } from '#lib/core/search/marks.ts';
import { parseSearchText, type SearchText } from '#lib/core/search/search-text.tiny.ts';
import { shownPath } from '#lib/core/shown-path.tiny.ts';
import { countOf, formatCount } from '#lib/core/viewer/words.ts';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { openedMatches, placesIn, type MatchPlace } from './search-places.ts';
import type { BlockState, PartState, Viewer } from './viewer.svelte.ts';

/** How long typing pauses before the diff is searched, so a search is not sent for every key. */
export const SEARCH_PAUSE_MS = 150;

/** A search as a newer version's viewer takes it over: open or not, and what is in the box. */
export interface CarriedSearch {
	readonly open: boolean;
	readonly text: string;
}

/** What the daemon found for the text and options last searched. */
export type Found =
	| { readonly kind: 'none' }
	| { readonly kind: 'searching' }
	| { readonly kind: 'failed'; readonly message: string }
	| {
			readonly kind: 'found';
			readonly text: SearchText;
			/** The text in its searched form. */
			readonly query: string;
			readonly options: DiffSearchOptions;
			/** Each part's matches, by its place in reading order. */
			readonly counts: ReadonlyMap<PartIndex, number>;
	  };

/**
 * The match the person is on: a part, and the line (or the part's name) and
 * offset in it. Its place among the part's matches is worked out again
 * whenever they change, as when lines are opened above it.
 */
export interface CurrentMatch {
	readonly at: PartIndex;
	readonly place: MatchPlace;
}

/** Whether two places are the same match: on the same line, or the name, at the same offset. */
function samePlace(a: MatchPlace, b: MatchPlace): boolean {
	if (a.kind === 'path' || b.kind === 'path') return a.kind === b.kind && a.start === b.start;
	return a.line === b.line && a.start === b.start;
}

/** Where a part's matches are, for drawing them: on its path, and on each line. */
export interface PartMarks {
	readonly path: readonly Mark[];
	readonly lines: ReadonlyMap<object, readonly (Mark & { readonly index: number })[]>;
}

const NO_LINE_MARKS: PartMarks['lines'] = new Map();

/**
 * What moving to matches changed, to put back when the search is closed or
 * cleared: the parts and hunks themselves, not their places, so nothing is
 * put back on another part or hunk, and nothing on lines fetched again since.
 */
interface Changed {
	readonly opened: Set<PartState>;
	readonly large: Set<PartState>;
	readonly whiteSpace: Set<{ readonly part: PartState; readonly hunk: HunkState }>;
}

type HunkState = Extract<BlockState, { kind: 'hunk' }>;

function nothingChanged(): Changed {
	return { opened: new SvelteSet(), large: new SvelteSet(), whiteSpace: new SvelteSet() };
}

export class DiffSearch {
	readonly #viewer: Viewer;
	/** Whether the search box is shown. */
	open = $state(false);
	/** What is in the box. */
	text = $state('');
	matchCase = $state(false);
	changedOnly = $state(false);
	skipClosed = $state(false);
	found = $state<Found>({ kind: 'none' });
	current = $state<CurrentMatch>();
	/** Why the last move to a match stopped short: the lines it needed could not be read. */
	problem = $state('');
	#changed: Changed = nothingChanged();
	/** Bumped for each search sent, so an answer to an older one is dropped. */
	#asked = 0;
	#pause: ReturnType<typeof setTimeout> | undefined;

	constructor(
		viewer: Viewer,
		options: { matchCase: boolean; changedOnly: boolean; skipClosed: boolean },
		carried?: CarriedSearch
	) {
		this.#viewer = viewer;
		this.matchCase = options.matchCase;
		this.changedOnly = options.changedOnly;
		this.skipClosed = options.skipClosed;
		if (carried !== undefined) {
			this.open = carried.open;
			this.text = carried.text;
		}
	}

	/**
	 * Hands the search over to the viewer of a newer version, which searches it
	 * again: whether it is open and what is in the box. This one stops, so no
	 * answer about the older version lands after it.
	 */
	handOver(): CarriedSearch {
		clearTimeout(this.#pause);
		this.#asked += 1;
		return { open: this.open, text: this.text };
	}

	get options(): DiffSearchOptions {
		return { matchCase: this.matchCase, changedOnly: this.changedOnly };
	}

	/** Whether a part's matches count, with the filter and the options as they are. */
	counts(at: PartIndex): boolean {
		const state = this.#viewer.parts[at];
		if (state === undefined || !this.#viewer.shows(at)) return false;
		return !(this.skipClosed && !state.open);
	}

	/** A part's matches: the daemon's count, and those in lines the page opened. */
	matchesIn(at: PartIndex): number {
		const found = this.found;
		if (found.kind !== 'found' || !this.counts(at)) return 0;
		const counted = found.counts.get(at) ?? 0;
		const lines = this.#viewer.parts[at]?.lines;
		return lines?.kind === 'loaded'
			? counted + openedMatches(lines.blocks, found.query, found.options)
			: counted;
	}

	/** Every match counted, and in how many files. */
	get totals(): { readonly matches: number; readonly files: number } {
		if (this.found.kind !== 'found') return { matches: 0, files: 0 };
		let matches = 0;
		const files = new SvelteSet<string>();
		for (const state of this.#viewer.parts) {
			const here = this.matchesIn(state.index);
			if (here === 0) continue;
			matches += here;
			files.add(state.part.path);
		}
		return { matches, files: files.size };
	}

	/**
	 * Where the current match is among its part's matches, as they are now;
	 * undefined when there is none, or its part no longer counts, as when the
	 * filter hides it or it was closed with Skip closed files on.
	 */
	#currentIndex(): number | undefined {
		const current = this.current;
		if (current === undefined || !this.counts(current.at)) return undefined;
		const index = this.#placesOf(current.at).findIndex((p) => samePlace(p, current.place));
		return index < 0 ? undefined : index;
	}

	/** The current match's place among all of them, from 1, while it counts. */
	get ordinal(): number | undefined {
		const current = this.current;
		const index = this.#currentIndex();
		if (current === undefined || index === undefined) return undefined;
		let before = 0;
		for (let at = 0; at < current.at; at += 1) before += this.matchesIn(partIndexOf(at));
		return before + index + 1;
	}

	/** What the search box says of what was found. */
	get summary(): string {
		const found = this.found;
		switch (found.kind) {
			case 'none':
				return '';
			case 'searching':
				return 'Searching…';
			case 'failed':
				return found.message;
			case 'found': {
				if (this.problem !== '') return this.problem;
				const { matches, files } = this.totals;
				if (matches === 0) return 'No matches';
				const where = `${countOf(matches, 'match', 'matches')} in ${countOf(files, 'file', 'files')}`;
				const ordinal = this.ordinal;
				if (ordinal !== undefined) return `${formatCount(ordinal)} of ${where}`;
				// The match the person was on is hidden or skipped now: Enter goes on from there.
				return this.current === undefined
					? `${where}. Press Enter to go to the first.`
					: `${where}. Press Enter to go to the next.`;
			}
		}
	}

	/** Where a part's matches are, for drawing them; undefined when it has none to draw. */
	marksIn(at: PartIndex): PartMarks | undefined {
		const found = this.found;
		const state = this.#viewer.parts[at];
		if (found.kind !== 'found' || state === undefined || !this.counts(at)) return undefined;
		if ((found.counts.get(at) ?? 0) === 0 && state.lines.kind !== 'loaded') return undefined;
		const places = this.#placesOf(at);
		if (places.length === 0) return undefined;
		const current = this.current?.at === at ? this.current.place : undefined;
		const path: Mark[] = [];
		const lines = new SvelteMap<object, (Mark & { index: number })[]>();
		for (const [index, place] of places.entries()) {
			const mark = {
				start: place.start,
				length: place.length,
				current: current !== undefined && samePlace(place, current)
			};
			if (place.kind === 'path') {
				path.push(mark);
				continue;
			}
			const on = lines.get(place.line);
			if (on === undefined) lines.set(place.line, [{ ...mark, index }]);
			else on.push({ ...mark, index });
		}
		return { path, lines: lines.size === 0 ? NO_LINE_MARKS : lines };
	}

	#placesOf(at: PartIndex): readonly MatchPlace[] {
		const found = this.found;
		const state = this.#viewer.parts[at];
		if (found.kind !== 'found' || state === undefined) return [];
		return placesIn(
			shownPath(state.part.path),
			state.lines.kind === 'loaded' ? state.lines.blocks : undefined,
			found.query,
			found.options
		);
	}

	/** The text in the box changed: the diff is searched once typing pauses. */
	typed(text: string): void {
		this.text = text;
		clearTimeout(this.#pause);
		this.#pause = setTimeout(() => {
			void this.search();
		}, SEARCH_PAUSE_MS);
	}

	/**
	 * Searches the diff for what is in the box, with the options as they are.
	 * An empty box puts back what moving to matches changed, and finds nothing.
	 */
	async search(): Promise<void> {
		clearTimeout(this.#pause);
		const asked = (this.#asked += 1);
		this.current = undefined;
		this.problem = '';
		if (this.text === '') {
			this.found = { kind: 'none' };
			this.putBack();
			return;
		}
		const text = parseSearchText(this.text);
		if (!text.ok) {
			this.found = {
				kind: 'failed',
				message:
					text.error.reason === 'too-long'
						? 'That is too long to search for: search for part of it.'
						: 'Search for text on one line.'
			};
			return;
		}
		const options = this.options;
		this.found = { kind: 'searching' };
		const viewer = this.#viewer;
		const answer = await viewer.client.searchDiff(viewer.id, {
			version: viewer.version,
			view: viewer.view,
			text: text.value,
			matchCase: options.matchCase,
			changedOnly: options.changedOnly
		});
		if (asked !== this.#asked) return;
		if (!answer.ok) {
			this.found = {
				kind: 'failed',
				message: `Could not search: ${describeApiError(answer.error)}`
			};
			return;
		}
		this.found = {
			kind: 'found',
			text: text.value,
			query: searchedQuery(text.value, options.matchCase),
			options,
			counts: this.#countsOf(answer.value)
		};
	}

	#countsOf(answer: DiffSearchView): ReadonlyMap<PartIndex, number> {
		const counts = new SvelteMap<PartIndex, number>();
		for (const part of answer.parts) {
			const at = this.#viewer.partOf(part.group, part.path);
			if (at !== undefined) counts.set(at, part.matches);
		}
		return counts;
	}

	/**
	 * The next match, or the previous, from the one the person is on, or from
	 * the part they are on; past the last it goes round to the first. The part
	 * it is in has its lines fetched first, when the page lacks them.
	 */
	async step(forward: boolean): Promise<CurrentMatch | undefined> {
		const found = this.found;
		if (found.kind !== 'found') return undefined;
		this.problem = '';
		const viewer = this.#viewer;
		const count = viewer.parts.length;
		const current = this.current;
		const currentIndex = this.#currentIndex();
		const from = current?.at ?? viewer.current ?? partIndexOf(forward ? 0 : Math.max(0, count - 1));
		for (let n = 0; n <= count; n += 1) {
			const raw = forward ? from + n : from - n;
			const at = partIndexOf(((raw % count) + count) % count);
			if (!this.counts(at) || this.matchesIn(at) === 0) continue;
			const places = await this.#loadedPlaces(at);
			if (found !== this.found) return undefined;
			// Its lines could not be read: say so, rather than pass over its matches unseen.
			const state = viewer.parts[at];
			if (state?.lines.kind === 'failed') {
				this.problem = `Could not read the lines of ${shownPath(state.part.path)}, so its matches cannot be shown. ${state.lines.message} Press Enter to try again.`;
				return undefined;
			}
			// From the match the person is on, the one after it; anywhere else, a part's
			// first (or last). The last turn comes back to where it began, so the search
			// goes round within a part that holds every match.
			const index =
				n === 0 && currentIndex !== undefined
					? currentIndex + (forward ? 1 : -1)
					: forward
						? 0
						: places.length - 1;
			const place = places[index];
			if (place === undefined) continue;
			return this.#moveTo(at, place);
		}
		return undefined;
	}

	/** A part's matches, once its lines are here: fetched now, or waited for when on their way. */
	async #loadedPlaces(at: PartIndex): Promise<readonly MatchPlace[]> {
		await this.#viewer.load(at);
		return this.#placesOf(at);
	}

	/** Makes a match the current one, and the page show it: its part open and its line drawn. */
	#moveTo(at: PartIndex, place: MatchPlace): CurrentMatch {
		const viewer = this.#viewer;
		const state = viewer.parts[at];
		if (state !== undefined) {
			if (!state.open) {
				state.open = true;
				this.#changed.opened.add(state);
			}
			if (viewer.isLarge(state)) {
				state.showLarge = true;
				this.#changed.large.add(state);
			}
			if (place.kind === 'line' && state.lines.kind === 'loaded') {
				const block = state.lines.blocks[place.block];
				if (block?.kind === 'hunk' && viewer.hideWhiteSpace && !block.showWhiteSpace) {
					const drawn = viewer.drawnLines(block);
					if (
						drawn.some(
							(d) => d.kind === 'quiet' && (d.removed === place.line || d.added === place.line)
						)
					) {
						block.showWhiteSpace = true;
						this.#changed.whiteSpace.add({ part: state, hunk: block });
					}
				}
			}
		}
		viewer.current = at;
		viewer.drawUpTo(at);
		const moved = { at, place };
		this.current = moved;
		return moved;
	}

	/** What the page says of the current match, for screen readers. */
	describeCurrent(): string {
		const current = this.current;
		const state = current === undefined ? undefined : this.#viewer.parts[current.at];
		if (current === undefined || state === undefined || this.ordinal === undefined) {
			return this.summary;
		}
		const path = shownPath(state.part.path);
		const where =
			current.place.kind === 'path'
				? `in the name of ${path}`
				: `in ${path}, line ${String('new' in current.place.line ? current.place.line.new : current.place.line.old)}`;
		return `${this.summary}, ${where}.`;
	}

	/** Puts back what moving to matches opened and showed. */
	putBack(): void {
		for (const state of this.#changed.opened) state.open = false;
		for (const state of this.#changed.large) state.showLarge = false;
		for (const { part, hunk } of this.#changed.whiteSpace) {
			// Only while the hunk is still among its part's lines, never on lines fetched again.
			if (part.lines.kind === 'loaded' && part.lines.blocks.includes(hunk)) {
				hunk.showWhiteSpace = false;
			}
		}
		this.#changed = nothingChanged();
		this.current = undefined;
	}

	/** Closes the search: nothing found, and the page as it was. */
	close(): void {
		clearTimeout(this.#pause);
		this.#asked += 1;
		this.open = false;
		this.found = { kind: 'none' };
		this.putBack();
	}
}
