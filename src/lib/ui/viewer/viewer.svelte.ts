/**
 * What a diff's page holds while a person reads it: its parts in reading order
 * with whether each is open and what of its lines has been fetched, the
 * by-file list, the filter, where the person is, and what to announce. The
 * page draws it; everything it changes on the daemon goes through the typed
 * client, on the version the page shows.
 *
 * Lines are fetched a part at a time, when a part comes near the screen or is
 * opened, and unchanged lines a step at a time, so a diff of 2,000 files opens
 * as fast as a small one. A very large part waits behind "Show this large
 * change" until asked.
 *
 * Code is coloured by language when the person wants it: once a part's lines
 * are shown, the colours of the lines it shows are asked for, a few parts at a
 * time, and drawn when they come; until then the lines are plain, in the same
 * place. Lines opened later are coloured the same way.
 */
import { describeApiError, type ApiClient, type ApiError } from '#lib/api/client.ts';
import type {
	DiffPage,
	DiffSummary,
	FileView,
	GroupKeyView,
	Marked,
	PartLines,
	PartView,
	ShownLineView,
	SideColoursView,
	TallyView,
	ViewName
} from '#lib/api/schemas.ts';
import { groupKeyId } from '#lib/core/group-key-id.tiny.ts';
import { lineNumberOf, type LineNumber } from '#lib/core/line-number.tiny.ts';
import type { EscapedPath } from '#lib/core/path-bytes.ts';
import { shownPath } from '#lib/core/shown-path.tiny.ts';
import type { LineText } from '#lib/core/line-text.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { unitCountOf } from '#lib/core/unit-count.tiny.ts';
import {
	linesToOpen,
	stillHidden,
	type Direction,
	type Opened
} from '#lib/core/viewer/expansion.ts';
import type { LineSpan } from '#lib/core/viewer/part-lines.ts';
import {
	nextShown,
	nextWaiting,
	previousShown,
	shownParts
} from '#lib/core/viewer/reading-order.ts';
import { partIndexOf, type PartIndex } from '#lib/core/part-index.tiny.ts';
import { countOf, describeChanges, formatCount } from '#lib/core/viewer/words.ts';
import { pageClient } from '#lib/ui/client.ts';
import { SvelteMap } from 'svelte/reactivity';
import type { ColourRun } from '#lib/core/highlight/colour-run.ts';
import type { Layout, ViewSettings } from '#lib/core/settings.ts';
import { spansOf } from '#lib/core/viewer/line-spans.ts';
import { couldBeColoured } from '#lib/core/highlight/language.ts';
import {
	quietWhiteSpace,
	type LineForWhiteSpace,
	type Quieted
} from '#lib/core/viewer/white-space.ts';
import { AskedLines, COLOUR_REQUESTS_AT_ONCE, PART_REQUESTS_AT_ONCE, Turns } from './requests.ts';
import { hiddenIn } from './white-space-notice.ts';
import { DiffSearch, type CarriedSearch } from './search.svelte.ts';

/** How many parts are drawn at first, and how many more after each frame. */
export const FIRST_BATCH = 40;
export const NEXT_BATCH = 30;

/** A part with more rows than this waits behind "Show this large change". */
export const LARGE_PART_ROWS = 800;

/** An unchanged line opened in a part, numbered on both sides. */
export interface OpenLine {
	readonly old: LineNumber;
	readonly new: LineNumber;
	readonly text: LineText;
}

export type BlockState =
	| {
			readonly kind: 'hidden';
			readonly old: LineSpan;
			readonly new: LineSpan;
			/** Opened at the top, below the hunk above, in order. */
			top: OpenLine[];
			/** Opened at the bottom, above the hunk below, in order. */
			bottom: OpenLine[];
			busy: boolean;
			problem: string;
	  }
	| {
			readonly kind: 'hunk';
			readonly heading: LineText;
			readonly lines: readonly ShownLineView[];
			/** Its white-space changes shown although the person hides them elsewhere. */
			showWhiteSpace: boolean;
	  }
	| {
			readonly kind: 'elsewhere';
			readonly groups: readonly GroupKeyView[];
			readonly lines: readonly ShownLineView[];
			/** Whether its lines are shown here too. */
			shown: boolean;
	  };

export type LinesState =
	| { readonly kind: 'waiting' }
	| { readonly kind: 'loading' }
	| { readonly kind: 'failed'; readonly message: string }
	| { readonly kind: 'loaded'; readonly blocks: BlockState[]; readonly sizes: PartLines['sizes'] };

/** The colours of a part's lines that have come, by side and line number. */
export interface LineColours {
	readonly old: SvelteMap<number, readonly ColourRun[]>;
	readonly new: SvelteMap<number, readonly ColourRun[]>;
}

/** Why a part's file is shown plain although colours were asked for, when it is worth saying. */
export type PlainBecause = 'large' | 'minified' | 'failed';

/**
 * Each hunk's lines as drawn, with white space shown and hidden, worked out
 * once: a hunk of 80,000 rows is drawn a chunk at a time, and each chunk would
 * otherwise work them out again.
 */
const DRAWN = new WeakMap<
	readonly ShownLineView[],
	{
		readonly plain?: readonly Quieted<ShownLineView>[];
		readonly quiet?: readonly Quieted<ShownLineView>[];
	}
>();

/** What the white-space rule needs of a line: its kind, text and group. */
function forWhiteSpace(line: ShownLineView): LineForWhiteSpace {
	return {
		kind: line.kind,
		text: line.text,
		group: line.kind === 'context' || line.home.kind === 'here' ? '' : groupKeyId(line.home.group)
	};
}

/** Puts the colours of one side's lines that came where the page draws them from. */
function putColours(into: LineColours['old'], side: SideColoursView): void {
	if (side?.kind !== 'coloured') return;
	for (const line of side.lines) into.set(line.number, line.runs);
}

/**
 * The lines a part's blocks show, by the side whose colours they take: a
 * removed line its old line, an added, unchanged or opened line its new one.
 * Changes of another group are shown muted, so they are not coloured.
 */
export function shownLineNumbers(blocks: readonly BlockState[]): {
	readonly old: readonly LineNumber[];
	readonly new: readonly LineNumber[];
} {
	const old: LineNumber[] = [];
	const now: LineNumber[] = [];
	for (const block of blocks) {
		if (block.kind === 'hidden') {
			for (const line of [...block.top, ...block.bottom]) now.push(line.new);
			continue;
		}
		for (const line of block.lines) {
			switch (line.kind) {
				case 'context':
					now.push(line.new);
					break;
				case 'deleted':
					if (line.home.kind === 'here') old.push(line.old);
					break;
				case 'added':
					if (line.home.kind === 'here') now.push(line.new);
					break;
			}
		}
	}
	return { old, new: now };
}

export interface PartState {
	/** Its place in reading order, which its element's id uses. */
	readonly index: PartIndex;
	/** The same for the same part of the same file in any answer: group and path. */
	readonly key: string;
	part: PartView;
	open: boolean;
	/** Whether it is on the screen or near it, so its lines are wanted when open. */
	near: boolean;
	/** For a large part: whether the person asked to see it. */
	showLarge: boolean;
	lines: LinesState;
	/** A tick being saved. */
	busy: boolean;
	/** Why the last tick did not happen, in place. */
	problem: string;
	/** The tick was refused because the diff has a newer version than the page shows. */
	behind: boolean;
	/** The colours of its lines that have come. */
	colours: LineColours;
	/** How many requests for its colours are under way: while any is, its lines say they are busy. */
	colouring: number;
	/** Why it is shown plain although colours were asked for, if it is worth saying. */
	plain: PlainBecause | undefined;
}

export interface GroupInfo {
	readonly key: GroupKeyView;
	readonly id: string;
	/** Its element's id on the page. */
	readonly anchor: string;
	/** As the page names it: a section's title, "Ignored", "Not sorted yet". */
	readonly name: string;
	/** Its parts' places in reading order: `first` to `first + count - 1`. */
	readonly first: PartIndex;
	readonly count: number;
}

function keyOf(group: GroupKeyView, path: EscapedPath): string {
	return `${groupKeyId(group)}\u0000${path}`;
}

/** Whether a part still waits for the reviewer. */
export function waits(part: PartView): boolean {
	return part.group.kind !== 'ignored' && part.tally.reviewed < part.tally.units;
}

/** Whether every change of a part, file or group is reviewed. */
export function done(tally: TallyView): boolean {
	return tally.units > 0 && tally.reviewed === tally.units;
}

/** Whether some but not all changes of a part, file or group are reviewed: its box is partly ticked. */
export function partly(tally: TallyView): boolean {
	return tally.reviewed > 0 && tally.reviewed < tally.units;
}

/**
 * Puts a tick box back as the diff has it, ticked, partly ticked or not, after
 * a press whose tick may not have happened: the browser changed the box when
 * pressed, and only a change of the tally would change it back.
 */
export function showTally(box: HTMLInputElement, tally: TallyView): void {
	box.checked = done(tally);
	box.indeterminate = partly(tally);
}

function shownOf(path: EscapedPath | undefined): string {
	return path === undefined ? '' : shownPath(path);
}

function sameTally(a: TallyView, b: TallyView): boolean {
	return (
		a.units === b.units &&
		a.reviewed === b.reviewed &&
		a.fresh === b.fresh &&
		a.unmarked === b.unmarked
	);
}

export function sumTallies(tallies: readonly TallyView[]): TallyView {
	let units = 0;
	let reviewed = 0;
	let fresh = 0;
	let unmarked = 0;
	for (const t of tallies) {
		units += t.units;
		reviewed += t.reviewed;
		fresh += t.fresh;
		unmarked += t.unmarked;
	}
	return {
		units: unitCountOf(units),
		reviewed: unitCountOf(reviewed),
		fresh: unitCountOf(fresh),
		unmarked: unitCountOf(unmarked)
	};
}

/** A group as the page names it. */
export function groupName(key: GroupKeyView, title: string | null): string {
	switch (key.kind) {
		case 'section':
			return title ?? key.section;
		case 'tests':
			return `Tests: ${title ?? key.section}`;
		case 'ignored':
			return 'Ignored';
		case 'uncategorised':
			return 'Not sorted yet';
	}
}

/** What the reviewer ticks, as the API names it. */
export type TickTarget =
	| { readonly kind: 'part'; readonly at: PartIndex }
	| { readonly kind: 'file'; readonly path: FileView['path'] }
	| { readonly kind: 'group'; readonly group: GroupInfo };

/** A tick of a file or a group that did not happen, and why. */
export interface Refusal {
	readonly kind: 'file' | 'group';
	/** The file's path, or the group's id. */
	readonly key: string;
	/** "Nothing was marked." and why, with what to do. */
	readonly message: string;
	/** The diff has a newer version than the page shows. */
	readonly behind: boolean;
}

/** What a tick came to, for the page to move focus and say so. */
export type TickOutcome =
	| {
			readonly kind: 'marked';
			readonly groupFinished: GroupInfo | undefined;
			readonly allDone: boolean;
	  }
	| { readonly kind: 'refused'; readonly outOfDate: boolean };

export class Viewer {
	readonly id: ReportId;
	readonly version: RevisionNumber;
	readonly view: ViewName;
	readonly groups: readonly GroupInfo[];
	summary: DiffSummary;
	parts: PartState[];
	files: FileView[];
	/** "Only what I have not reviewed". */
	onlyWaiting: boolean;
	/** The part the person is on: the last moved to, or the one holding focus. */
	current = $state<PartIndex>();
	/**
	 * How many parts, in reading order, are drawn. A large diff is drawn a
	 * batch at a time after its first screen, so the first file is readable at
	 * once and the page stays responsive while the rest are drawn.
	 */
	rendered = $state(FIRST_BATCH);
	/** What the page says to screen readers, politely. */
	announcement = $state('');
	/** Why the last tick of a file or a group did not happen; a part's is the part's own. */
	refused = $state<Refusal>();
	/** Whether changes that only change white space are drawn as unchanged lines; the person's setting. */
	hideWhiteSpace = $state(false);
	/** Whether code is coloured by language; the person's setting. */
	colouring = $state(true);
	/**
	 * How parts' lines are drawn: the person's setting, but one column when the
	 * window is too narrow for two.
	 */
	layout = $state<Layout>('unified');

	/** Searching within the diff. */
	readonly search: DiffSearch;
	/** How it asks the daemon: the page's own client, or a test's. */
	readonly client: ApiClient;

	/** Where each part is; fixed for the viewer's life, so not reactive. */
	readonly #byKey: ReadonlyMap<string, PartIndex>;
	readonly #groupOf: number[] = [];
	/** Where each file is in the by-file list. */
	readonly #fileAt: ReadonlyMap<EscapedPath, number>;
	/** Parts' lines being fetched, and those waiting their turn (`PART_REQUESTS_AT_ONCE`). */
	readonly #lineTurns = new Turns(PART_REQUESTS_AT_ONCE);
	/** Parts' colours being fetched, and those waiting their turn. */
	readonly #colourTurns = new Turns(COLOUR_REQUESTS_AT_ONCE);
	/** Parts' lines on their way, so a second asker waits for the same answer. */
	readonly #loading = new WeakMap<PartState, Promise<void>>();
	/** Which lines' colours each part has asked for, so none is asked for twice. */
	readonly #askedColours = new AskedLines();
	/** How many ticks have been answered, so a slower refresh never undoes a newer tick. */
	#ticks = 0;

	constructor(
		page: DiffPage,
		onlyWaiting: boolean,
		settings: ViewSettings,
		client: ApiClient = pageClient(),
		/** The search of the version shown before, which this one takes over. */
		search?: CarriedSearch
	) {
		this.client = client;
		this.summary = $state.raw(page.summary);
		this.colouring = settings.colours;
		this.hideWhiteSpace = settings.hideWhiteSpace;
		this.onlyWaiting = $state(onlyWaiting);
		this.id = page.summary.id;
		this.version = page.summary.version;
		this.view = page.view;
		const groups: GroupInfo[] = [];
		const parts: PartState[] = [];
		const byKey = new SvelteMap<string, PartIndex>();
		for (const group of page.groups) {
			const info: GroupInfo = {
				key: group.key,
				id: groupKeyId(group.key),
				anchor: `group-${String(groups.length)}`,
				name: groupName(group.key, group.title),
				first: partIndexOf(parts.length),
				count: group.parts.length
			};
			groups.push(info);
			for (const part of group.parts) {
				const index = partIndexOf(parts.length);
				const key = keyOf(part.group, part.path);
				byKey.set(key, index);
				this.#groupOf.push(groups.length - 1);
				parts.push({
					index,
					key,
					part,
					open: part.group.kind !== 'ignored' && !done(part.tally),
					near: false,
					showLarge: false,
					lines: { kind: 'waiting' },
					busy: false,
					problem: '',
					behind: false,
					colours: { old: new SvelteMap(), new: new SvelteMap() },
					colouring: 0,
					plain: undefined
				});
			}
		}
		this.groups = groups;
		this.#byKey = byKey;
		this.parts = $state(parts);
		this.files = $state([...page.files]);
		const fileAt = new SvelteMap<EscapedPath, number>();
		for (const [at, file] of page.files.entries()) fileAt.set(file.path, at);
		this.#fileAt = fileAt;
		this.search = new DiffSearch(
			this,
			{
				matchCase: settings.searchMatchCase,
				changedOnly: settings.searchChangedOnly,
				skipClosed: settings.searchSkipClosed
			},
			search
		);
	}

	/** The group a part is in. */
	groupOfPart(at: PartIndex): GroupInfo | undefined {
		const group = this.#groupOf[at];
		return group === undefined ? undefined : this.groups[group];
	}

	/** The group with this key, if the page has it. */
	groupWithKey(key: GroupKeyView): GroupInfo | undefined {
		const id = groupKeyId(key);
		return this.groups.find((g) => g.id === id);
	}

	/** Where a file's part in a group is in reading order. */
	partOf(group: GroupKeyView, path: EscapedPath): PartIndex | undefined {
		return this.#byKey.get(keyOf(group, path));
	}

	groupTally(group: GroupInfo): TallyView {
		return sumTallies(
			this.parts.slice(group.first, group.first + group.count).map((p) => p.part.tally)
		);
	}

	/** Every part outside Ignored. */
	get overall(): TallyView {
		return sumTallies(
			this.parts.filter((p) => p.part.group.kind !== 'ignored').map((p) => p.part.tally)
		);
	}

	get waiting(): readonly boolean[] {
		return this.parts.map((p) => waits(p.part));
	}

	/** Whether the page shows a part, with the filter as it is. */
	shows(at: PartIndex): boolean {
		const part = this.parts[at];
		return part !== undefined && (!this.onlyWaiting || waits(part.part));
	}

	/** Whether a part is drawn yet (see `rendered`). */
	drawn(at: PartIndex): boolean {
		return at < this.rendered;
	}

	/** Draws every part up to `at`, so it can be moved to. */
	drawUpTo(at: PartIndex): void {
		if (at >= this.rendered) this.rendered = at + 1;
	}

	/** The next part that waits after the one the person is on, or the first. */
	nextUnread(): PartIndex | undefined {
		return nextWaiting(this.waiting, this.current);
	}

	/** Which parts the page shows, with the filter as it is. */
	get shown(): readonly boolean[] {
		return shownParts(this.waiting, this.onlyWaiting);
	}

	/**
	 * The part shown after the one the person is on (or the first), stopping at
	 * the end; from a part the filter has just hidden, the one shown after where
	 * it was.
	 */
	nextShown(): PartIndex | undefined {
		return nextShown(this.shown, this.current);
	}

	/** The part shown before the one the person is on (or the last), stopping at the top. */
	previousShown(): PartIndex | undefined {
		return previousShown(this.shown, this.current);
	}

	/** Whether a part is drawn large, behind its control. */
	isLarge(part: PartState): boolean {
		return part.part.rows > LARGE_PART_ROWS && !part.showLarge;
	}

	/**
	 * Fetches a part's lines, once. When they are already on their way, waits
	 * for them; afterwards they are loaded, or failed with the reason.
	 */
	async load(at: PartIndex): Promise<void> {
		const state = this.parts[at];
		if (state === undefined || state.lines.kind === 'loaded') return;
		if (state.lines.kind === 'loading') {
			await this.#loading.get(state);
			return;
		}
		const fetching = this.#fetchLines(state);
		this.#loading.set(state, fetching);
		try {
			await fetching;
		} finally {
			this.#loading.delete(state);
		}
	}

	async #fetchLines(state: PartState): Promise<void> {
		if (state.part.content !== 'text' && state.part.content !== 'binary') {
			state.lines = { kind: 'loaded', blocks: [], sizes: null };
			return;
		}
		state.lines = { kind: 'loading' };
		const release = await this.#lineTurns.take();
		let read: Awaited<ReturnType<ApiClient['readPart']>>;
		try {
			read = await this.client.readPart(this.id, {
				version: this.version,
				view: this.view,
				group: state.part.group,
				path: state.part.path
			});
		} finally {
			release();
		}
		if (!read.ok) {
			state.lines = { kind: 'failed', message: describeApiError(read.error) };
			return;
		}
		state.lines = {
			kind: 'loaded',
			sizes: read.value.sizes,
			blocks: read.value.blocks.map((block): BlockState => {
				switch (block.kind) {
					case 'hidden':
						return { ...block, top: [], bottom: [], busy: false, problem: '' };
					case 'hunk':
						return { ...block, showWhiteSpace: false };
					case 'elsewhere':
						return { ...block, shown: false };
				}
			})
		};
	}

	/**
	 * Asks for the colours of the lines a part shows that it has not asked for
	 * yet, when code is coloured, and draws them when they come. Lines are plain
	 * until then, and stay plain if the colours cannot be had.
	 */
	async colour(at: PartIndex): Promise<void> {
		const state = this.parts[at];
		if (!this.colouring || state?.lines.kind !== 'loaded' || state.lines.sizes !== null) return;
		if (!couldBeColoured(state.part.path)) return;
		const shown = shownLineNumbers(state.lines.blocks);
		const { old, new: now } = this.#askedColours.ask(at, shown.old, shown.new);
		if (old.length === 0 && now.length === 0) return;
		state.colouring += 1;
		try {
			await this.#lineTurns.idle();
			const release = await this.#colourTurns.take();
			let read: Awaited<ReturnType<ApiClient['readColours']>>;
			try {
				read = await this.client.readColours(this.id, {
					version: this.version,
					path: state.part.path,
					old: spansOf(old.map(lineNumberOf)),
					new: spansOf(now.map(lineNumberOf))
				});
			} finally {
				release();
			}
			if (!read.ok) return;
			putColours(state.colours.old, read.value.old);
			putColours(state.colours.new, read.value.new);
			for (const side of [read.value.new, read.value.old]) {
				if (side?.kind === 'plain' && side.reason !== 'language' && side.reason !== 'binary') {
					state.plain = side.reason;
				}
			}
		} finally {
			state.colouring -= 1;
		}
	}

	/** Opens hidden lines of a part's block: a step down, a step up, or all of them. */
	async openLines(at: PartIndex, block: number, direction: Direction): Promise<void> {
		const state = this.parts[at];
		if (state?.lines.kind !== 'loaded') return;
		const hidden = state.lines.blocks[block];
		if (hidden?.kind !== 'hidden' || hidden.busy) return;
		const opened = openedOf(hidden);
		const range = linesToOpen(opened, direction);
		if (range === undefined) return;
		hidden.busy = true;
		hidden.problem = '';
		const read = await this.client.readLines(this.id, {
			version: this.version,
			side: 'new',
			path: state.part.path,
			first: range.first,
			last: range.last
		});
		hidden.busy = false;
		if (!read.ok) {
			hidden.problem = describeApiError(read.error);
			return;
		}
		const offset = hidden.old.first - hidden.new.first;
		const lines = read.value.lines.map((l): OpenLine => ({
			old: lineNumberOf(l.number + offset),
			new: l.number,
			text: l.text
		}));
		if (direction === 'up') hidden.bottom = [...lines, ...hidden.bottom];
		else hidden.top = [...hidden.top, ...lines];
	}

	/** A hunk's lines as drawn: with the white-space changes as unchanged lines, when they are hidden. */
	drawnLines(
		block: Extract<BlockState, { kind: 'hunk' | 'elsewhere' }>
	): readonly Quieted<ShownLineView>[] {
		const quiet = this.hideWhiteSpace && !(block.kind === 'hunk' && block.showWhiteSpace);
		const kept = DRAWN.get(block.lines);
		const found = quiet ? kept?.quiet : kept?.plain;
		if (found !== undefined) return found;
		const made = quiet
			? quietWhiteSpace(block.lines, forWhiteSpace)
			: block.lines.map((line): Quieted<ShownLineView> => ({ kind: 'line', line }));
		DRAWN.set(block.lines, { ...kept, [quiet ? 'quiet' : 'plain']: made });
		return made;
	}

	/**
	 * How many of a part's own changes are drawn as unchanged lines because
	 * they only change white space: the page says so, and that a tick covers them.
	 */
	hiddenWhiteSpace(at: PartIndex): number {
		const state = this.parts[at];
		if (!this.hideWhiteSpace || state?.lines.kind !== 'loaded') return 0;
		let hidden = 0;
		for (const block of state.lines.blocks) {
			if (block.kind !== 'hunk') continue;
			hidden += hiddenIn(this.drawnLines(block));
		}
		return hidden;
	}

	/** Shows a part's white-space changes as changes again, in every hunk. */
	showWhiteSpace(at: PartIndex): void {
		const state = this.parts[at];
		if (state?.lines.kind !== 'loaded') return;
		for (const block of state.lines.blocks) if (block.kind === 'hunk') block.showWhiteSpace = true;
	}

	/** Whether every unchanged line of a part is open: the whole file is shown. */
	wholeShown(at: PartIndex): boolean {
		const state = this.parts[at];
		if (state?.lines.kind !== 'loaded') return false;
		return state.lines.blocks.every((b) => b.kind !== 'hidden' || hiddenCount(b) === 0);
	}

	/** Whether a part has hidden lines at all. */
	hasHidden(at: PartIndex): boolean {
		const state = this.parts[at];
		if (state?.lines.kind !== 'loaded') return false;
		return state.lines.blocks.some((b) => b.kind === 'hidden');
	}

	/** Shows the whole file of a part, every hidden line opened; or, when it is shown, only its changes again. */
	async wholeFile(at: PartIndex): Promise<void> {
		const state = this.parts[at];
		if (state === undefined) return;
		state.open = true;
		await this.load(at);
		if (state.lines.kind !== 'loaded') return;
		if (this.wholeShown(at)) {
			for (const block of state.lines.blocks) {
				if (block.kind === 'hidden') {
					block.top = [];
					block.bottom = [];
				}
			}
			return;
		}
		await Promise.all(
			state.lines.blocks.map((block, i) =>
				block.kind === 'hidden' ? this.openLines(at, i, 'all') : Promise.resolve()
			)
		);
	}

	/** Marks a part, a file or a group reviewed, or not, on the version the page shows. */
	async tick(target: TickTarget, reviewed: boolean): Promise<TickOutcome> {
		const busy = this.#partsOf(target);
		for (const part of busy) {
			part.busy = true;
			part.problem = '';
			part.behind = false;
		}
		this.refused = undefined;
		const before = target.kind === 'group' ? undefined : this.groupOfPartIn(target);
		const sent = await this.client.markReviewed(this.id, {
			version: this.version,
			view: this.view,
			reviewed,
			target:
				target.kind === 'part'
					? {
							kind: 'slice',
							group: this.parts[target.at]?.part.group ?? { kind: 'uncategorised' },
							path: this.parts[target.at]?.part.path ?? ''
						}
					: target.kind === 'file'
						? { kind: 'file', path: target.path }
						: { kind: 'group', group: target.group.key }
		});
		for (const part of busy) part.busy = false;
		this.#ticks += 1;
		if (!sent.ok) return this.#refused(sent.error, busy, target);
		this.summary = sent.value.summary;
		for (const part of sent.value.parts) {
			const at = this.#byKey.get(keyOf(part.group, part.path));
			const state = at === undefined ? undefined : this.parts[at];
			if (state === undefined) continue;
			const wasDone = done(state.part.tally);
			state.part = part;
			// A part just ticked is put away, and one just unticked is opened again, as
			// GitHub does; its lines are fetched when it comes near the screen, as any
			// part's are (Part.svelte), so unticking 2,000 parts fetches only those in view.
			if (!wasDone && done(part.tally)) state.open = false;
			if (wasDone && !done(part.tally) && part.group.kind !== 'ignored') state.open = true;
		}
		this.#putFiles(sent.value.files);
		// What is stored differs from what the page holds: another page on the same
		// diff ticked or unticked something. Its ticks and progress are fetched again.
		if (!this.#agrees(sent.value.groups)) await this.refreshTicks();
		const overall = this.overall;
		const allDone = overall.units > 0 && overall.reviewed === overall.units;
		const finished =
			reviewed && before !== undefined && done(this.groupTally(before)) ? before : undefined;
		this.announcement = this.#describeTick(target, reviewed, finished, allDone);
		return {
			kind: 'marked',
			groupFinished: target.kind === 'group' && reviewed ? target.group : finished,
			allDone
		};
	}

	/**
	 * Brings the ticks and progress the page shows up to date with what is
	 * stored for the version it shows, as when another page on the same diff
	 * marked something: each part's tally and each file's, nothing else. What is
	 * open, the lines fetched, the filter and where the reader is stay as they
	 * are, so nothing moves under them. An answer that comes after a tick made
	 * meanwhile is dropped, since the tick's own answer is newer.
	 */
	async refreshTicks(): Promise<void> {
		if (this.parts.some((p) => p.busy)) return;
		const ticks = this.#ticks;
		const loaded = await this.client.loadDiff(this.id, this.view, this.version);
		if (!loaded.ok || ticks !== this.#ticks || this.parts.some((p) => p.busy)) return;
		this.summary = loaded.value.summary;
		for (const group of loaded.value.groups) {
			for (const part of group.parts) {
				const at = this.#byKey.get(keyOf(part.group, part.path));
				const state = at === undefined ? undefined : this.parts[at];
				if (state !== undefined && !sameTally(state.part.tally, part.tally)) state.part = part;
			}
		}
		this.#putFiles(loaded.value.files);
	}

	/** Puts files the daemon sent in place of the page's own. */
	#putFiles(files: readonly FileView[]): void {
		for (const file of files) {
			const at = this.#fileAt.get(file.path);
			if (at !== undefined) this.files[at] = file;
		}
	}

	/** Whether every group's figures, as stored, are those the page holds. */
	#agrees(groups: Marked['groups']): boolean {
		return groups.every((stored) => {
			const group = this.groupWithKey(stored.key);
			if (group === undefined) return stored.units === 0;
			const held = this.groupTally(group);
			return held.units === stored.units && held.reviewed === stored.reviewed;
		});
	}

	groupOfPartIn(target: TickTarget): GroupInfo | undefined {
		return target.kind === 'part' ? this.groupOfPart(target.at) : undefined;
	}

	#partsOf(target: TickTarget): PartState[] {
		switch (target.kind) {
			case 'part': {
				const part = this.parts[target.at];
				return part === undefined ? [] : [part];
			}
			case 'file':
				return this.parts.filter((p) => p.part.path === target.path);
			case 'group':
				return this.parts.slice(target.group.first, target.group.first + target.group.count);
		}
	}

	#refused(error: ApiError, parts: readonly PartState[], target: TickTarget): TickOutcome {
		const message = `Nothing was marked. ${describeApiError(error)}`;
		const first = parts[0];
		const outOfDate = error.kind === 'refused' && error.reason === 'VersionOutOfDate';
		// Said where the tick was made, as an alert, in either view.
		switch (target.kind) {
			case 'part':
				if (first !== undefined) {
					first.problem = message;
					first.behind = outOfDate;
				}
				break;
			case 'file':
				this.refused = { kind: 'file', key: target.path, message, behind: outOfDate };
				break;
			case 'group':
				this.refused = { kind: 'group', key: target.group.id, message, behind: outOfDate };
				break;
		}
		return { kind: 'refused', outOfDate };
	}

	#describeTick(
		target: TickTarget,
		reviewed: boolean,
		finished: GroupInfo | undefined,
		allDone: boolean
	): string {
		const what =
			target.kind === 'part'
				? shownOf(this.parts[target.at]?.part.path)
				: target.kind === 'file'
					? shownPath(target.path)
					: target.group.name;
		const overall = this.overall;
		const progress = `${formatCount(overall.reviewed)} of ${describeChanges(overall.units)} reviewed.`;
		const hidden = target.kind === 'part' ? this.hiddenWhiteSpace(target.at) : 0;
		const including =
			hidden > 0
				? ` That includes ${countOf(hidden, 'change', 'changes')} to white space that ${hidden === 1 ? 'is' : 'are'} not shown.`
				: '';
		const said = `${what} ${reviewed ? 'marked as reviewed' : 'no longer marked as reviewed'}.${including} ${progress}`;
		if (allDone) return `${said} Everything is reviewed.`;
		if (finished !== undefined) return `${said} ${finished.name} is all reviewed.`;
		return said;
	}
}

function openedOf(block: Extract<BlockState, { kind: 'hidden' }>): Opened {
	return { span: block.new, top: block.top.length, bottom: block.bottom.length };
}

/** How many lines of a hidden block are still hidden. */
export function hiddenCount(block: Extract<BlockState, { kind: 'hidden' }>): number {
	return stillHidden(openedOf(block));
}

/** The lines the next step in a direction would open, for its label. */
export function nextStep(
	block: Extract<BlockState, { kind: 'hidden' }>,
	direction: Direction
): { readonly first: LineNumber; readonly last: LineNumber } | undefined {
	return linesToOpen(openedOf(block), direction);
}
