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
import type { ReviewNumber } from '#lib/core/review-number.tiny.ts';
import { describeApiError, type ApiClient, type ApiError } from '#lib/api/client.ts';
import type {
	DiffPage,
	DiffSummary,
	FileView,
	GroupKeyView,
	Marked,
	NoteAction,
	RequestAction,
	PartLines,
	PartView,
	PlaceView,
	ShownLineView,
	SideColoursView,
	TallyView,
	ViewName
} from '#lib/api/schemas.ts';
import { groupKeyId } from '#lib/core/group-key-id.tiny.ts';
import { lineNumberOf, type LineNumber } from '#lib/core/line-number.tiny.ts';
import { resolveEscapedPath, type EscapedPath } from '#lib/core/path-bytes.ts';
import { namedAsImage } from '#lib/core/image/image-format.ts';
import { shownPath } from '#lib/core/shown-path.tiny.ts';
import type { LineText } from '#lib/core/line-text.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { unitCountOf } from '#lib/core/unit-count.tiny.ts';
import {
	EXPANSION_STEP,
	linesToOpen,
	stillHidden,
	type Direction,
	type Opened
} from '#lib/core/viewer/expansion.ts';
import { bookmarkContext, openedContext, type BookmarkLine } from './bookmark.ts';
import type { LineSpan } from '#lib/core/viewer/part-lines.ts';
import {
	nextShown,
	nextWaiting,
	previousShown,
	shownParts
} from '#lib/core/viewer/reading-order.ts';
import { partIndexOf, type PartIndex } from '#lib/core/part-index.tiny.ts';
import {
	nextUnreadPlace,
	summariesLeft,
	type ReadingPlace,
	type ToRead,
	type WritingPlace
} from '#lib/core/viewer/reading-places.ts';
import type { AgentMarkdown } from '#lib/core/agent-markdown.tiny.ts';
import type { SummaryPlace } from '#lib/core/review/summary-read.ts';
import type { OrderStep } from '#lib/core/order-step.tiny.ts';
import { countOf, describeChanges, formatCount } from '#lib/core/viewer/words.ts';
import { pageClient } from '#lib/ui/client.ts';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
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
			/** A bounded stretch opened around a bookmark, between the two edges. */
			bookmark: OpenLine[];
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
			readonly places: readonly PlaceView[];
			readonly lines: readonly ShownLineView[];
			/** Whether its lines are shown here too. */
			shown: boolean;
	  };

export type LinesState =
	| { readonly kind: 'waiting' }
	| { readonly kind: 'loading' }
	| { readonly kind: 'failed'; readonly message: string }
	| {
			readonly kind: 'loaded';
			readonly blocks: BlockState[];
			readonly sizes: PartLines['sizes'];
			readonly image: PartLines['image'];
	  };

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
		group:
			line.kind === 'context' || line.home.kind === 'here'
				? ''
				: placeKey(line.home.group, line.home.step)
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
			for (const line of openedContext(block)) now.push(line.new);
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
	/** The same for the same part of the same file in any answer: group, step and path. */
	readonly key: string;
	/** The view measures this part while restoring the reader's place. */
	measuring: boolean;
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
	readonly summary: DiffPage['overview'];
	/** Its parts' places in reading order: `first` to `first + count - 1`. */
	readonly first: PartIndex;
	readonly count: number;
}

/** A place written as text: a group, and its step in a section's reading order. */
export function placeKey(group: GroupKeyView, step: OrderStep | null): string {
	return step === null ? groupKeyId(group) : `${groupKeyId(group)}#${String(step)}`;
}

function keyOf(group: GroupKeyView, path: EscapedPath, step: OrderStep | null): string {
	return `${placeKey(group, step)}\u0000${path}`;
}

/** The section whose summary a group shows, if it is a section's or its Tests group. */
function sectionOf(key: GroupKeyView): SummaryPlace | undefined {
	return key.kind === 'section' || key.kind === 'tests'
		? { kind: 'section', section: key.section }
		: undefined;
}

/** A text of the agent's, as the page keeps it read: what it is and the words read. */
function readKey(place: SummaryPlace, text: AgentMarkdown): string {
	return `${place.kind === 'overview' ? '' : place.section}\u0000${text}`;
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
			readonly refresh: boolean;
	  }
	| { readonly kind: 'refused'; readonly outOfDate: boolean }
	| { readonly kind: 'sorting-changed'; readonly message: string };

/** What can be done to the agent's notes, without the version, which is the one shown. */
export type NoteActionKind = DistributiveOmit<NoteAction, 'version'>;

/** What can be done to the reviewer's questions for the agent, without the version shown. */
export type RequestActionKind = DistributiveOmit<RequestAction, 'version'>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class Viewer {
	readonly id: ReportId;
	readonly version: RevisionNumber;
	/** The finished review the page shows the Delve as of, read-only; undefined for the Delve as it is. */
	readonly asOf: ReviewNumber | undefined;
	readonly view: ViewName;
	#frame: string;
	#sorting: string;
	readonly assignments: DiffPage['assignments'];
	/** A lazy request found that this frame's assignments are no longer current. */
	assignmentsChanged = $state(false);
	readonly sorted: boolean;
	groups: readonly GroupInfo[];
	overview = $state<DiffPage['overview']>(null);
	/** The agent's notes on this version, dismissed ones too; promoted ones are comments by then. */
	notes = $state.raw<DiffPage['notes']>([]);
	/** On a version with no notes, what to say of an earlier version's. */
	earlierNotes = $state.raw<DiffPage['earlierNotes']>(null);
	/** Whether the agent's notes are drawn at their lines; the person's setting. */
	showNotes = $state(true);
	/** The reviewer's questions for the agent, on every version (DESIGN 7.2). */
	requests = $state.raw<DiffPage['requests']>([]);
	/** Whether an agent is listening for them now: "Agent connected". */
	agentConnected = $state(false);
	/** The Delve's latest finished review, so the page offers its history; null before the first. */
	latestReview = $state<ReviewNumber | null>(null);
	/** The threads of earlier reviews on this version (DESIGN 6.3); none for a browser that may not read reviews. */
	threads = $state.raw<NonNullable<DiffPage['threads']>>([]);
	summary: DiffSummary;
	parts: PartState[];
	files: FileView[];
	/** "Only what I have not reviewed". */
	onlyWaiting: boolean;
	/** The part the person is on: the last moved to, or the one holding focus. */
	current = $state<PartIndex>();
	/**
	 * The agent's overview or a group's summary, when the page took the person
	 * there and they have not moved since: moving on from it marks it read.
	 */
	atSummary = $state<WritingPlace>();
	/** The agent's texts the reviewer has read, by what each is and its words (`readKey`). */
	readonly #read = new SvelteSet<string>();
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
	/** Unchanged lines being opened in each part, so a key pressed meanwhile can wait for them. */
	readonly #opening = new WeakMap<PartState, Promise<unknown>>();
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
		search?: CarriedSearch,
		/** The same version before the agent changed its sorting. */
		previous?: Viewer
	) {
		this.client = client;
		this.summary = $state.raw(page.summary);
		this.colouring = settings.colours;
		this.hideWhiteSpace = settings.hideWhiteSpace;
		this.showNotes = settings.agentNotes;
		this.onlyWaiting = $state(onlyWaiting);
		this.id = page.summary.id;
		this.version = page.summary.version;
		this.asOf = page.asOf?.review;
		this.view = page.view;
		this.#frame = page.frame;
		this.#sorting = page.sorting;
		this.assignments = page.assignments;
		this.sorted = page.sorted;
		this.overview = page.overview;
		this.notes = page.notes;
		this.earlierNotes = page.earlierNotes;
		this.requests = page.requests;
		this.agentConnected = page.agentConnected;
		this.latestReview = page.latestReview;
		this.threads = page.threads ?? [];
		this.#takeRead(page);
		// Read on the page before a regroup, whether or not it has been saved yet.
		if (previous !== undefined) for (const key of previous.#read) this.#read.add(key);
		const groups: GroupInfo[] = [];
		const parts: PartState[] = [];
		const byKey = new SvelteMap<string, PartIndex>();
		for (const group of page.groups) {
			const info: GroupInfo = {
				key: group.key,
				id: groupKeyId(group.key),
				anchor: `group-${groupKeyId(group.key)}`,
				name: groupName(group.key, group.title),
				summary: group.summary,
				first: partIndexOf(parts.length),
				count: group.parts.length
			};
			groups.push(info);
			for (const part of group.parts) {
				const index = partIndexOf(parts.length);
				const key = keyOf(part.group, part.path, part.step);
				const before = previous === undefined ? undefined : previous.#partWithKey(key);
				byKey.set(key, index);
				this.#groupOf.push(groups.length - 1);
				parts.push({
					index,
					key,
					measuring: false,
					part,
					open: before?.open ?? (part.group.kind !== 'ignored' && !done(part.tally)),
					near: before?.near ?? false,
					showLarge: before?.showLarge ?? false,
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
		this.groups = $state.raw(groups);
		this.#byKey = byKey;
		this.parts = $state(parts);
		if (previous?.current !== undefined) {
			const before = previous.parts[previous.current];
			this.current = before === undefined ? undefined : this.nearestPart(before);
			if (this.current !== undefined) this.drawUpTo(this.current);
		}
		// The summary the person is on stays theirs, found again by its group, whose key names its section.
		const was = previous?.atSummary;
		if (was?.kind === 'overview') this.atSummary = was;
		else if (was !== undefined && previous !== undefined) {
			const id = previous.groups[was.group]?.id;
			const group = groups.findIndex((g) => g.id === id);
			if (group >= 0) this.atSummary = { kind: 'summary', group };
		}
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

	#partWithKey(key: string): PartState | undefined {
		const index = this.#byKey.get(key);
		return index === undefined ? undefined : this.parts[index];
	}

	/** Same slice, then the same file, then the closest displayed slice. */
	nearestPart(before: PartState): PartIndex | undefined {
		const same = this.#byKey.get(before.key);
		if (same !== undefined && this.shows(same)) return same;
		const file = this.parts.find(
			(part) => part.part.path === before.part.path && this.shows(part.index)
		);
		if (file !== undefined) return file.index;
		const near = Math.min(before.index, this.parts.length - 1);
		if (near < 0) return undefined;
		const index = partIndexOf(near);
		return this.shows(index)
			? index
			: (nextShown(this.shown, index) ?? previousShown(this.shown, index));
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

	/**
	 * Where a file's part in a group is in reading order: the part of `step`
	 * (null for the part after the steps), or with `step` left out the file's
	 * first part in the group.
	 */
	partOf(group: GroupKeyView, path: EscapedPath, step?: OrderStep | null): PartIndex | undefined {
		if (step !== undefined) return this.#byKey.get(keyOf(group, path, step));
		const id = groupKeyId(group);
		return this.parts.find((p) => p.part.path === path && groupKeyId(p.part.group) === id)?.index;
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

	/** What is left to read, the agent's unread overview and summaries among it. */
	get toRead(): ToRead {
		return {
			overviewUnread: this.overview !== null && !this.#isRead({ kind: 'overview' }, this.overview),
			groups: this.groups.map((group) => {
				const place = sectionOf(group.key);
				return {
					first: group.first,
					count: group.count,
					unreadSummary:
						place?.kind === 'section' &&
						group.summary !== null &&
						!this.#isRead(place, group.summary)
							? place.section
							: undefined
				};
			}),
			waiting: this.waiting
		};
	}

	/**
	 * The next unread thing after where the person is, the agent's overview and
	 * summaries among it (DESIGN 8.1), or undefined when nothing is left.
	 */
	nextUnreadPlace(from: ReadingPlace | undefined = this.here()): ReadingPlace | undefined {
		return nextUnreadPlace(this.toRead, from);
	}

	/** Where the person is: the summary the page took them to, or the part they are on. */
	here(): ReadingPlace | undefined {
		return (
			this.atSummary ??
			(this.current === undefined ? undefined : { kind: 'part', at: this.current })
		);
	}

	/** How much of the agent's writing is left to read. */
	get summariesLeft(): { overview: boolean; summaries: number } {
		return summariesLeft(this.toRead);
	}

	/** Whether a group's summary is unread. */
	summaryUnread(group: GroupInfo): boolean {
		const place = sectionOf(group.key);
		return place !== undefined && group.summary !== null && !this.#isRead(place, group.summary);
	}

	/**
	 * The person moves on from the overview or a summary the page took them to:
	 * it is read, kept at once on the page and saved for the Delve. A save that
	 * fails leaves it read on this page only, so it is read again next time.
	 * Gives where the person was, to go on from.
	 */
	moveOnFromSummary(): ReadingPlace | undefined {
		const from = this.here();
		const at = this.atSummary;
		this.atSummary = undefined;
		if (at === undefined) return from;
		const group = at.kind === 'summary' ? this.groups[at.group] : undefined;
		const place = group === undefined ? { kind: 'overview' as const } : sectionOf(group.key);
		const text = group === undefined ? this.overview : group.summary;
		if (place === undefined || text === null || this.#isRead(place, text)) return from;
		this.#read.add(readKey(place, text));
		void this.client.markSummaryRead(this.id, { version: this.version, place });
		return from;
	}

	#isRead(place: SummaryPlace, text: AgentMarkdown): boolean {
		return this.#read.has(readKey(place, text));
	}

	/** What a frame says was read, kept beside what this page has read since. */
	#takeRead(page: DiffPage): void {
		if (page.overview !== null && page.overviewRead) {
			this.#read.add(readKey({ kind: 'overview' }, page.overview));
		}
		for (const group of page.groups) {
			const place = sectionOf(group.key);
			if (place !== undefined && group.summary !== null && group.summaryRead) {
				this.#read.add(readKey(place, group.summary));
			}
		}
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

	/**
	 * Whether any part may have an image changed in place to compare: one whose
	 * lines have come with a picture on both sides, or one named as an image
	 * whose lines have not come yet.
	 */
	hasImagesToCompare(): boolean {
		return this.parts.some((state) => {
			if (state.lines.kind === 'loaded') {
				const image = state.lines.image;
				return image?.old?.kind === 'image' && image.new?.kind === 'image';
			}
			const path = resolveEscapedPath(state.part.path);
			return path !== undefined && namedAsImage(path);
		});
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
			state.lines = { kind: 'loaded', blocks: [], sizes: null, image: null };
			return;
		}
		state.lines = { kind: 'loading' };
		const release = await this.#lineTurns.take();
		let read: Awaited<ReturnType<ApiClient['readPart']>>;
		try {
			read = await this.client.readPart(this.id, {
				version: this.version,
				assignments: this.assignments,
				view: this.view,
				group: state.part.group,
				path: state.part.path,
				step: state.part.step ?? undefined
			});
		} finally {
			release();
		}
		if (!read.ok) {
			this.noteReadRefusal(read.error);
			state.lines = { kind: 'failed', message: describeApiError(read.error) };
			return;
		}
		state.lines = {
			kind: 'loaded',
			sizes: read.value.sizes,
			image: read.value.image,
			blocks: read.value.blocks.map((block): BlockState => {
				switch (block.kind) {
					case 'hidden':
						return { ...block, top: [], bottom: [], bookmark: [], busy: false, problem: '' };
					case 'hunk':
						return { ...block, showWhiteSpace: false };
					case 'elsewhere':
						return { ...block, shown: false };
				}
			})
		};
	}

	noteReadRefusal(error: ApiError): void {
		if (error.kind === 'refused' && error.reason === 'AssignmentsChanged') {
			this.assignmentsChanged = true;
		}
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
	openLines(at: PartIndex, block: number, direction: Direction): Promise<void> {
		return this.#whileOpening(at, () => this.#openLines(at, block, direction));
	}

	/**
	 * Waits for a part's lines and for any of its unchanged lines being opened,
	 * so what is drawn next, such as the line `c` goes to, is among them.
	 */
	async settled(at: PartIndex): Promise<void> {
		await this.load(at);
		const state = this.parts[at];
		const opening = state === undefined ? undefined : this.#opening.get(state);
		if (opening !== undefined) await opening;
	}

	/** Does `work` on a part, which `settled` then waits for, with all begun before it. */
	async #whileOpening(at: PartIndex, work: () => Promise<void>): Promise<void> {
		const state = this.parts[at];
		if (state === undefined) return;
		const done = work();
		const all = Promise.allSettled([this.#opening.get(state), done]);
		this.#opening.set(state, all);
		try {
			await done;
		} finally {
			await all;
			if (this.#opening.get(state) === all) this.#opening.delete(state);
		}
	}

	async #openLines(at: PartIndex, block: number, direction: Direction): Promise<void> {
		const state = this.parts[at];
		if (state?.lines.kind !== 'loaded') return;
		const hidden = state.lines.blocks[block];
		if (hidden?.kind !== 'hidden' || hidden.busy) return;
		const opened = openedOf(hidden);
		const range = linesToOpen(opened, direction);
		if (range === undefined) return;
		const lines = await this.#readContext(state, hidden, range);
		if (lines === undefined) return;
		if (direction === 'up') hidden.bottom = [...lines, ...hidden.bottom];
		else hidden.top = [...hidden.top, ...lines];
	}

	/** Opens a bounded window around a saved line in the middle of unchanged context. */
	openBookmarkContext(at: PartIndex, block: number, target: BookmarkLine): Promise<void> {
		return this.#whileOpening(at, () => this.#openBookmarkContext(at, block, target));
	}

	async #openBookmarkContext(at: PartIndex, block: number, target: BookmarkLine): Promise<void> {
		const state = this.parts[at];
		if (state?.lines.kind !== 'loaded') return;
		const hidden = state.lines.blocks[block];
		if (hidden?.kind !== 'hidden' || hidden.busy) return;
		const line = target.line - hidden[target.side].first + hidden.new.first;
		const firstHidden = hidden.new.first + hidden.top.length;
		const lastHidden = hidden.new.last - hidden.bottom.length;
		if (
			line < firstHidden ||
			line > lastHidden ||
			hidden.bookmark.some((item) => item.new === line)
		)
			return;
		const lines = await this.#readContext(state, hidden, {
			first: lineNumberOf(Math.max(firstHidden, line - EXPANSION_STEP)),
			last: lineNumberOf(Math.min(lastHidden, line + EXPANSION_STEP))
		});
		if (lines !== undefined) hidden.bookmark = lines;
	}

	async #readContext(
		state: PartState,
		hidden: Extract<BlockState, { kind: 'hidden' }>,
		range: LineSpan
	): Promise<OpenLine[] | undefined> {
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
			return undefined;
		}
		const offset = hidden.old.first - hidden.new.first;
		return read.value.lines.map((l): OpenLine => ({
			old: lineNumberOf(l.number + offset),
			new: l.number,
			text: l.text
		}));
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
					block.bookmark = [];
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
	async tick(
		target: TickTarget,
		reviewed: boolean,
		beforeClose?: (part: PartState) => void
	): Promise<TickOutcome> {
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
							sorting: this.#sorting,
							group: this.parts[target.at]?.part.group ?? { kind: 'uncategorised' },
							path: this.parts[target.at]?.part.path ?? '',
							step: this.parts[target.at]?.part.step ?? null
						}
					: target.kind === 'file'
						? { kind: 'file', path: target.path }
						: { kind: 'group', group: target.group.key, sorting: this.#sorting }
		});
		for (const part of busy) part.busy = false;
		this.#ticks += 1;
		if (!sent.ok) return this.#refused(sent.error, busy, target);
		if (sent.value.sorting !== this.#sorting) {
			return { kind: 'marked', groupFinished: undefined, allDone: false, refresh: true };
		}
		this.summary = sent.value.summary;
		for (const part of sent.value.parts) {
			const at = this.#byKey.get(keyOf(part.group, part.path, part.step));
			const state = at === undefined ? undefined : this.parts[at];
			if (state === undefined) continue;
			const wasDone = done(state.part.tally);
			if (!wasDone && done(part.tally)) beforeClose?.(state);
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
		const refresh = !this.#agrees(sent.value.groups);
		const overall = this.overall;
		const allDone = overall.units > 0 && overall.reviewed === overall.units;
		const finished =
			reviewed && before !== undefined && done(this.groupTally(before)) ? before : undefined;
		this.announcement = this.#describeTick(target, reviewed, finished, allDone);
		return {
			kind: 'marked',
			groupFinished: target.kind === 'group' && reviewed ? target.group : finished,
			allDone,
			refresh
		};
	}

	/**
	 * Checks the version the page shows. A tick made while the request was
	 * in flight takes precedence over its answer.
	 */
	async readRefresh(force: boolean): Promise<DiffPage | undefined> {
		if (this.parts.some((p) => p.busy)) return;
		const ticks = this.#ticks;
		const loaded = force
			? await this.client.loadDiff(this.id, this.view, this.version, this.asOf)
			: await this.client.refreshDiff(this.id, this.view, this.version, this.#frame, this.asOf);
		if (!loaded.ok || ticks !== this.#ticks || this.parts.some((p) => p.busy)) return;
		return loaded.value ?? undefined;
	}

	sameLayout(frame: DiffPage): boolean {
		return (
			this.assignments === frame.assignments &&
			this.groups.length === frame.groups.length &&
			frame.groups.every((group, index) => groupKeyId(group.key) === this.groups[index]?.id)
		);
	}

	/** Replaces only metadata and marks, keeping the mounted parts and loaded lines. */
	applyFrame(frame: DiffPage): void {
		this.#frame = frame.frame;
		this.#sorting = frame.sorting;
		this.overview = frame.overview;
		this.#takeRead(frame);
		this.notes = frame.notes;
		this.earlierNotes = frame.earlierNotes;
		this.requests = frame.requests;
		this.agentConnected = frame.agentConnected;
		this.latestReview = frame.latestReview;
		this.threads = frame.threads ?? [];
		this.summary = frame.summary;
		for (const group of frame.groups) {
			for (const part of group.parts) {
				const at = this.#byKey.get(keyOf(part.group, part.path, part.step));
				const state = at === undefined ? undefined : this.parts[at];
				if (state !== undefined && !sameTally(state.part.tally, part.tally)) state.part = part;
			}
		}
		this.groups = this.groups.map((info, index) => {
			const group = frame.groups[index];
			if (group === undefined) return info;
			const name = groupName(group.key, group.title);
			return name === info.name && group.summary === info.summary
				? info
				: { ...info, name, summary: group.summary };
		});
		this.#putFiles(frame.files);
	}

	/**
	 * Dismisses an agent note, promotes one into the draft, or brings back
	 * those dismissed, on the version shown. The notes are those the daemon
	 * gives back; what went wrong, in words, or undefined.
	 */
	async changeNotes(action: NoteActionKind): Promise<string | undefined> {
		const changed = await this.client.changeNotes(this.id, { ...action, version: this.version });
		if (!changed.ok) return describeApiError(changed.error);
		this.notes = changed.value.notes;
		this.announcement =
			action.action === 'dismiss'
				? 'Agent note dismissed. “Bring back dismissed notes”, above the diff, shows it again.'
				: action.action === 'promote'
					? 'Agent note promoted: it is a comment of yours now, which you can edit.'
					: 'Dismissed agent notes are back.';
		return undefined;
	}

	/**
	 * Asks the agent, cancels a question or promotes one into the draft, on
	 * the version shown. The questions are those the daemon gives back; what
	 * went wrong, in words, or undefined.
	 */
	async changeRequests(action: RequestActionKind): Promise<string | undefined> {
		const changed = await this.client.changeRequests(this.id, { ...action, version: this.version });
		if (!changed.ok) return describeApiError(changed.error);
		this.requests = changed.value.requests;
		this.lastAsked = changed.value.asked ?? undefined;
		this.announcement =
			action.action === 'ask'
				? this.agentConnected
					? 'Asked. The agent’s answer appears with your question.'
					: 'Asked. No agent is connected: copy it as a prompt for your agent.'
				: action.action === 'cancel'
					? 'Question cancelled.'
					: 'Question and answer promoted: they are a comment of yours now, which you can edit.';
		return undefined;
	}

	/** The question asked last from this page, to put the keyboard on once it is drawn. */
	lastAsked = $state<DiffPage['requests'][number]['id']>();

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
		if (error.kind === 'refused' && error.reason === 'SortingChanged') {
			return { kind: 'sorting-changed', message };
		}
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
	return stillHidden(openedOf(block)) - bookmarkContext(block).length;
}

/** The lines the next step in a direction would open, for its label. */
export function nextStep(
	block: Extract<BlockState, { kind: 'hidden' }>,
	direction: Direction
): { readonly first: LineNumber; readonly last: LineNumber } | undefined {
	return linesToOpen(openedOf(block), direction);
}
