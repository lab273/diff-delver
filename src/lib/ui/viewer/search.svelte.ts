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
import type { DiffSearchView, ShownLineView } from '#lib/api/schemas.ts';
import { partIndexOf, type PartIndex } from '#lib/core/part-index.tiny.ts';
import type { DiffSearchOptions } from '#lib/core/search/diff-search.ts';
import { searchedQuery } from '#lib/core/search/find-text.ts';
import type { Mark } from '#lib/core/search/marks.ts';
import {
	parseSearchText,
	type InvalidSearchTextReason,
	type SearchText
} from '#lib/core/search/search-text.tiny.ts';
import { shownPath } from '#lib/core/shown-path.tiny.ts';
import { countOf, formatCount } from '#lib/core/viewer/words.ts';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { openedMatches, placesIn, type MatchPlace } from './search-places.ts';
import type { BlockState, OpenLine, PartState, Viewer } from './viewer.svelte.ts';

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

/**
 * Why the last move to a match fell short, said in the search box while it is
 * still true: a part whose lines could not be read, where the move stopped,
 * or parts it went past because their lines could not be read a second time;
 * or the match moved to, which the page could not draw.
 */
type Trouble =
	| { readonly kind: 'unreadable'; readonly part: PartState }
	| { readonly kind: 'skipped'; readonly parts: readonly PartState[] }
	| { readonly kind: 'not-shown'; readonly match: CurrentMatch };

/** What the search box's status line says: the count, where the match is (said only to screen readers), and why a move fell short. */
export interface SearchStatus {
	readonly count: string;
	/** Where the current match is, as `, in a.ts, line 10`, or ''. */
	readonly where: string;
	readonly note: string;
}

/** Names in a list: `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
	const last = names.at(-1) ?? '';
	return names.length < 2 ? last : `${names.slice(0, -1).join(', ')} and ${last}`;
}

/** Why what is in the box cannot be searched for, and what to do instead. */
function whyNotSearched(reason: InvalidSearchTextReason): string {
	switch (reason) {
		case 'empty':
			return 'Type something to search for.';
		case 'too-long':
			return 'That is too long to search for: search for part of it.';
		case 'several-lines':
			return 'Search for text on one line.';
		case 'nul-byte':
			return 'That holds a NUL character, which no line of text holds: leave it out.';
	}
}

/** Where a match is, in words: the part's name, or a line, saying when it is a removed line. */
function placeInWords(path: string, place: MatchPlace): string {
	if (place.kind === 'path') return `in the name of ${path}`;
	const line = place.line;
	if ('kind' in line && line.kind === 'deleted') {
		return `in ${path}, removed line ${String(line.old)}, as it was numbered before the change`;
	}
	return `in ${path}, line ${String(line.new)}`;
}

/** Whether two places are the same match: on the same line, or the name, at the same offset. */
function samePlace(a: MatchPlace, b: MatchPlace): boolean {
	if (a.kind === 'path' || b.kind === 'path') return a.kind === b.kind && a.start === b.start;
	return a.line === b.line && a.start === b.start;
}

/** A line's numbers, on each side it is on. */
function numbersOf(line: ShownLineView | OpenLine): {
	readonly old?: number;
	readonly new?: number;
} {
	if (!('kind' in line)) return { old: line.old, new: line.new };
	switch (line.kind) {
		case 'context':
			return { old: line.old, new: line.new };
		case 'deleted':
			return { old: line.old };
		case 'added':
			return { new: line.new };
	}
}

/**
 * Whether match `a` comes before match `b` in their part, by where they are in
 * the file rather than by what is drawn, so it holds for a match whose line is
 * no longer drawn: the name first, then lines by their number on a side both
 * are on, the new one when both are on both; a removed line and an added one,
 * which share no side, by their block, and the removed one first in it.
 */
function comesBefore(a: MatchPlace, b: MatchPlace): boolean {
	if (a.kind === 'path' || b.kind === 'path') {
		if (a.kind !== b.kind) return a.kind === 'path';
		return a.start < b.start;
	}
	const [x, y] = [numbersOf(a.line), numbersOf(b.line)];
	const byNumber =
		x.new !== undefined && y.new !== undefined
			? x.new - y.new
			: x.old !== undefined && y.old !== undefined
				? x.old - y.old
				: a.block !== b.block
					? a.block - b.block
					: x.old !== undefined
						? -1
						: 1;
	return byNumber === 0 ? a.start < b.start : byNumber < 0;
}

/**
 * Where to go from the match the person is on, among its part's matches:
 * the one after it (or before), or, when its line is no longer drawn, as when
 * the lines opened around it are closed again, the first after where it was
 * (or the last before).
 */
function stepFrom(places: readonly MatchPlace[], from: MatchPlace, forward: boolean): number {
	const here = places.findIndex((p) => samePlace(p, from));
	if (here >= 0) return here + (forward ? 1 : -1);
	if (forward) {
		const after = places.findIndex((p) => comesBefore(from, p));
		return after < 0 ? places.length : after;
	}
	return places.findLastIndex((p) => comesBefore(p, from));
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
	#trouble = $state<Trouble>();
	/** Parts a move stopped at because their lines could not be read: the next move goes past them if they still cannot be. */
	#triedOnce = new SvelteSet<PartState>();
	#changed: Changed = nothingChanged();
	/** Bumped for each search sent, so an answer to an older one is dropped. */
	#asked = 0;
	#pause: ReturnType<typeof setTimeout> | undefined;
	/** A newer version's viewer has taken this search over: a move under way does nothing. */
	#handedOver = false;

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
		this.#handedOver = true;
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

	/**
	 * Why the last move fell short, while it is still true: once the lines it
	 * could not read have been read, as when the part's own Try again reads
	 * them, nothing.
	 */
	get problem(): string {
		const trouble = this.#trouble;
		if (trouble === undefined) return '';
		switch (trouble.kind) {
			case 'unreadable': {
				const lines = trouble.part.lines;
				if (lines.kind !== 'failed') return '';
				return `Could not read the lines of ${shownPath(trouble.part.part.path)}, so its matches cannot be shown. ${lines.message} Press Enter to try again.`;
			}
			case 'skipped': {
				const still = trouble.parts.filter((p) => p.lines.kind === 'failed');
				const [first] = still;
				if (first?.lines.kind !== 'failed') return '';
				const names = listed(still.map((p) => shownPath(p.part.path)));
				const whose = still.length === 1 ? 'its lines' : 'their lines';
				return `Skipped ${names}: ${whose} could not be read again. ${first.lines.message}`;
			}
			case 'not-shown': {
				if (this.current !== trouble.match) return '';
				const state = this.#viewer.parts[trouble.match.at];
				const path = state === undefined ? 'its file' : shownPath(state.part.path);
				return `The match moved to, in ${path}, could not be shown on the page. Press Enter to go to the next.`;
			}
		}
	}

	/**
	 * The page could not draw the match moved to: the search box says so, and
	 * claims no place among the matches for it, until the next move.
	 */
	notShown(match: CurrentMatch): void {
		if (this.current === match) this.#trouble = { kind: 'not-shown', match };
	}

	/** What the search box's status line says, in its pieces. */
	get status(): SearchStatus {
		const found = this.found;
		const only = (count: string): SearchStatus => ({ count, where: '', note: '' });
		switch (found.kind) {
			case 'none':
				return only('');
			case 'searching':
				return only('Searching…');
			case 'failed':
				return only(found.message);
			case 'found': {
				const problem = this.problem;
				// The move stopped short: no place among the matches is claimed.
				if (problem !== '' && this.#trouble?.kind !== 'skipped') {
					return { count: '', where: '', note: problem };
				}
				const { matches, files } = this.totals;
				if (matches === 0) return only('No matches');
				const counted = `${countOf(matches, 'match', 'matches')} in ${countOf(files, 'file', 'files')}`;
				const ordinal = this.ordinal;
				const current = this.current;
				const state = current === undefined ? undefined : this.#viewer.parts[current.at];
				if (ordinal !== undefined && current !== undefined && state !== undefined) {
					return {
						count: `${formatCount(ordinal)} of ${counted}`,
						where: `, ${placeInWords(shownPath(state.part.path), current.place)}`,
						note: problem
					};
				}
				// The match the person was on is hidden or skipped now: Enter goes on from there.
				const press =
					current === undefined
						? `${counted}. Press Enter to go to the first.`
						: `${counted}. Press Enter to go to the next.`;
				return { count: press, where: '', note: problem };
			}
		}
	}

	/** What the search box shows of what was found. */
	get summary(): string {
		const { count, note } = this.status;
		return count === '' ? note : note === '' ? count : `${count}. ${note}`;
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
		this.#trouble = undefined;
		this.#triedOnce.clear();
		if (this.text === '') {
			this.found = { kind: 'none' };
			this.putBack();
			return;
		}
		const text = parseSearchText(this.text);
		if (!text.ok) {
			this.found = { kind: 'failed', message: whyNotSearched(text.error.reason) };
			return;
		}
		const options = this.options;
		this.found = { kind: 'searching' };
		const viewer = this.#viewer;
		const answer = await viewer.client.searchDiff(viewer.id, {
			version: viewer.version,
			assignments: viewer.assignments,
			view: viewer.view,
			text: text.value,
			matchCase: options.matchCase,
			changedOnly: options.changedOnly
		});
		if (asked !== this.#asked) return;
		if (!answer.ok) {
			viewer.noteReadRefusal(answer.error);
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
			const at = this.#viewer.partOf(part.group, part.path, part.step);
			if (at !== undefined) counts.set(at, part.matches);
		}
		return counts;
	}

	/** Whether a move begun with `found` must stop: the search changed, or was handed over. */
	#outdated(found: Found): boolean {
		return found !== this.found || this.#handedOver;
	}

	/**
	 * The next match, or the previous, from the one the person is on, or from
	 * the part they are on; past the last it goes round to the first. The part
	 * it is in has its lines fetched first, when the page lacks them. Nothing,
	 * when the search changed or was handed over while they came.
	 */
	async step(forward: boolean): Promise<CurrentMatch | undefined> {
		const found = this.found;
		if (found.kind !== 'found' || this.#outdated(found)) return undefined;
		this.#trouble = undefined;
		// Lines read since, as by the part's own Try again: a later failure is tried once more.
		for (const part of this.#triedOnce)
			if (part.lines.kind === 'loaded') this.#triedOnce.delete(part);
		const skipped: PartState[] = [];
		const viewer = this.#viewer;
		const count = viewer.parts.length;
		const current = this.current;
		const from = current?.at ?? viewer.current ?? partIndexOf(forward ? 0 : Math.max(0, count - 1));
		for (let n = 0; n <= count; n += 1) {
			const raw = forward ? from + n : from - n;
			const at = partIndexOf(((raw % count) + count) % count);
			if (!this.counts(at) || this.matchesIn(at) === 0) continue;
			const places = await this.#loadedPlaces(at);
			if (this.#outdated(found)) return undefined;
			// Its lines could not be read: say so, rather than pass over its matches
			// unseen, and stop, so the next move tries once more. When they cannot be
			// read then either, go past it, saying so, so it never traps the reader.
			const state = viewer.parts[at];
			if (state?.lines.kind === 'failed') {
				if (this.#triedOnce.has(state)) {
					skipped.push(state);
					this.#trouble = { kind: 'skipped', parts: skipped };
					continue;
				}
				this.#triedOnce.add(state);
				this.#trouble = { kind: 'unreadable', part: state };
				return undefined;
			}
			if (state !== undefined) this.#triedOnce.delete(state);
			// From the match the person is on, the one after it, drawn or not; anywhere
			// else, a part's first (or last). The last turn comes back to where it
			// began, so the search goes round within a part that holds every match.
			const index =
				n === 0 && current?.at === at
					? stepFrom(places, current.place, forward)
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
		const { count, where, note } = this.status;
		if (where === '') return this.summary;
		return note === '' ? `${count}${where}.` : `${count}${where}. ${note}`;
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
