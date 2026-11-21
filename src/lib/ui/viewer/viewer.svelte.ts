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
 */
import { describeApiError, type ApiError } from '#lib/api/client.ts';
import type {
	DiffPage,
	DiffSummary,
	FileView,
	GroupKeyView,
	PartLines,
	PartView,
	ShownLineView,
	TallyView,
	ViewName
} from '#lib/api/schemas.ts';
import { groupKeyId } from '#lib/core/group-key-id.tiny.ts';
import { lineNumberOf, type LineNumber } from '#lib/core/line-number.tiny.ts';
import type { EscapedPath } from '#lib/core/path-bytes.ts';
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
import { describeChanges, formatCount } from '#lib/core/viewer/words.ts';
import { pageClient } from '#lib/ui/client.ts';
import { SvelteMap } from 'svelte/reactivity';

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
	| { readonly kind: 'hunk'; readonly heading: LineText; readonly lines: readonly ShownLineView[] }
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

export interface PartState {
	/** Its place in reading order, which its element's id uses. */
	readonly index: PartIndex;
	/** The same for the same part of the same file in any answer: group and path. */
	readonly key: string;
	part: PartView;
	open: boolean;
	/** For a large part: whether the person asked to see it. */
	showLarge: boolean;
	lines: LinesState;
	/** A tick being saved. */
	busy: boolean;
	/** Why the last tick did not happen, in place. */
	problem: string;
	/** The tick was refused because the diff has a newer version than the page shows. */
	behind: boolean;
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

	/** Where each part is; fixed for the viewer's life, so not reactive. */
	readonly #byKey: ReadonlyMap<string, PartIndex>;
	readonly #groupOf: number[] = [];

	constructor(page: DiffPage, onlyWaiting: boolean) {
		this.summary = $state.raw(page.summary);
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
					showLarge: false,
					lines: { kind: 'waiting' },
					busy: false,
					problem: '',
					behind: false
				});
			}
		}
		this.groups = groups;
		this.#byKey = byKey;
		this.parts = $state(parts);
		this.files = $state([...page.files]);
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

	/** Fetches a part's lines, once, unless they are on their way. */
	async load(at: PartIndex): Promise<void> {
		const state = this.parts[at];
		if (state === undefined) return;
		if (state.lines.kind === 'loading' || state.lines.kind === 'loaded') return;
		if (state.part.content !== 'text' && state.part.content !== 'binary') {
			state.lines = { kind: 'loaded', blocks: [], sizes: null };
			return;
		}
		state.lines = { kind: 'loading' };
		const read = await pageClient().readPart(this.id, {
			version: this.version,
			view: this.view,
			group: state.part.group,
			path: state.part.path
		});
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
						return block;
					case 'elsewhere':
						return { ...block, shown: false };
				}
			})
		};
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
		const read = await pageClient().readLines(this.id, {
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
		const sent = await pageClient().markReviewed(this.id, {
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
		if (!sent.ok) return this.#refused(sent.error, busy, target);
		this.summary = sent.value.summary;
		for (const part of sent.value.parts) {
			const at = this.#byKey.get(keyOf(part.group, part.path));
			const state = at === undefined ? undefined : this.parts[at];
			if (state === undefined) continue;
			const wasDone = done(state.part.tally);
			state.part = part;
			// A part just ticked is put away, and one just unticked is opened again, as GitHub does.
			if (!wasDone && done(part.tally)) state.open = false;
			if (wasDone && !done(part.tally) && part.group.kind !== 'ignored') {
				state.open = true;
				if (at !== undefined && !this.isLarge(state)) void this.load(at);
			}
		}
		for (const file of sent.value.files) {
			const at = this.files.findIndex((f) => f.path === file.path);
			if (at >= 0) this.files[at] = file;
		}
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
				? (this.parts[target.at]?.part.path ?? '')
				: target.kind === 'file'
					? target.path
					: target.group.name;
		const overall = this.overall;
		const progress = `${formatCount(overall.reviewed)} of ${describeChanges(overall.units)} reviewed.`;
		const said = `${what} ${reviewed ? 'marked as reviewed' : 'no longer marked as reviewed'}. ${progress}`;
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
