<!--
	One part's lines, as GitHub draws a diff: a table with the line numbers of
	both sides, a + or − beside each changed line so colour is never the only
	sign, its code, and between hunks the unchanged lines that are hidden, with
	what opens them. Changes that belong to another group are muted and say
	where they are; lines new since the previous version say so.

	Unified, the lines are one column, as git writes them. Side by side, the old
	side is on the left and the new on the right, paired as GitHub pairs them
	(`core/viewer/side-by-side.ts`); each row is read left to right, and the
	table's column headers, "Before" and "After", say which side a cell is on.
-->
<script lang="ts">
	import type { GroupKeyView, ShownLineView } from '#lib/api/schemas.ts';
	import type { EscapedPath } from '#lib/core/path-bytes.ts';
	import { shownPath } from '#lib/core/shown-path.tiny.ts';
	import type { PartIndex } from '#lib/core/part-index.tiny.ts';
	import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
	import type { BlockState, LineColours, OpenLine, Viewer } from './viewer.svelte.ts';
	import { hiddenCount, nextStep } from './viewer.svelte.ts';
	import { drawLine } from './draw-line.ts';
	import { wholeHunkHidden } from './white-space-notice.ts';
	import { tick } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { chunksOf } from '#lib/core/viewer/chunks.ts';
	import { EXPANSION_STEP, type Direction } from '#lib/core/viewer/expansion.ts';
	import { countOf } from '#lib/core/viewer/words.ts';
	import { sideBySide, type LineSide, type SideRow } from '#lib/core/viewer/side-by-side.ts';
	import type { Quieted } from '#lib/core/viewer/white-space.ts';
	import type { Layout } from '#lib/core/settings.ts';
	import type { Mark } from '#lib/core/search/marks.ts';
	import { ROWS_PER_CHUNK } from '#lib/core/viewer/chunks.ts';
	import { GutterLines, type GutterLine, type GutterRow } from './gutter-lines.ts';
	import type { DraftCommentView } from '#lib/api/schemas.ts';
	import {
		byLastLine,
		inSelection,
		lineKey,
		selectionBetween,
		type LineSelection
	} from '#lib/core/review/comment-places.ts';
	import { describeCommentLines } from '#lib/core/review/draft-comment.ts';
	import ReviewAccess from '#lib/ui/ReviewAccess.svelte';
	import CommentBox from './CommentBox.svelte';
	import SavedComment from './SavedComment.svelte';
	import type { Comments, Writing } from './comments.svelte.ts';
	import { parseLineNumber, type LineNumber } from '#lib/core/line-number.tiny.ts';
	import { parseSide, type Side } from '#lib/core/side.tiny.ts';
	import type { PartMarks } from './search.svelte.ts';

	import { bookmarkContext, openedContext, type BookmarkLine } from './bookmark.ts';

	let {
		bookmarkLine,
		viewer,
		at,
		blocks,
		path,
		previousVersion,
		ongo,
		colours,
		busy,
		layout,
		marks,
		comments,
		canComment,
		canReview,
		showNewer
	}: {
		bookmarkLine?: BookmarkLine | undefined;
		viewer: Viewer;
		at: PartIndex;
		blocks: BlockState[];
		/** The colours of its lines that have come; undefined to draw them plain. */
		colours: LineColours | undefined;
		/** Whether colours are on their way: the lines say they are busy until they come. */
		busy: boolean;
		/** One column, or old and new side by side. */
		layout: Layout;
		path: EscapedPath;
		/** The version before this one, for "new since version 1"; null for a first version. */
		previousVersion: RevisionNumber | null;
		/** Goes to the part of this file in another group. */
		ongo: (group: GroupKeyView) => void;
		/** A search's matches in the part, to mark; undefined when it has none. */
		marks: PartMarks | undefined;
		/** The reviewer's comments on this Delve, saved and being written. */
		comments: Comments;
		/** Whether a comment can be started here: the Delve is open. */
		canComment: boolean;
		/** Whether this browser may write comments; one let in by a link is told how, in place. */
		canReview: boolean;
		showNewer: () => void;
	} = $props();

	/** The current search match's place, when it is in this part. */
	const current = $derived(viewer.search.current?.at === at ? viewer.search.current : undefined);

	/** A line's matches, to mark on it. */
	function marksOn(line: object): readonly Mark[] | undefined {
		return marks?.lines.get(line);
	}

	/** Whether the match the person is on is on this line, so the page can scroll to it. */
	function holdsCurrent(line: object): boolean {
		return current?.place.kind === 'line' && current.place.line === line;
	}

	// The chunk of a long hunk holding the current match is drawn, wherever it is.
	$effect(() => {
		const place = current?.place;
		if (place?.kind !== 'line' || place.opened) return;
		const block = blocks[place.block];
		if (block?.kind !== 'hunk') return;
		const shown = viewer.drawnLines(block);
		const holds = (item: Drawn | undefined): boolean =>
			item !== undefined &&
			(item.kind === 'line'
				? item.line === place.line
				: item.removed === place.line || item.added === place.line);
		const row = split
			? pairedRows(shown).findIndex((pair) => holds(pair.old) || holds(pair.new))
			: shown.findIndex(holds);
		if (row < ROWS_PER_CHUNK) return;
		drawn.add(
			`${String(place.block)}:${String(Math.floor(row / ROWS_PER_CHUNK) * ROWS_PER_CHUNK)}`
		);
	});

	const hasFresh = $derived(
		blocks.some(
			(b) =>
				b.kind === 'hunk' &&
				b.lines.some((l) => l.kind !== 'context' && l.home.kind === 'here' && l.home.fresh)
		)
	);
	const split = $derived(layout === 'side-by-side');
	/** Columns of one side by side: number, the "new" badge when any line has it, marker and code. */
	const sideColumns = $derived(hasFresh ? 4 : 3);
	const columns = $derived(split ? sideColumns * 2 : hasFresh ? 5 : 4);

	/** A line drawn, or a white-space change drawn as one unchanged line (`core/viewer/white-space.ts`). */
	type Drawn = Quieted<ShownLineView>;

	/** Each hunk's rows side by side, worked out once rather than for each chunk drawn. */
	const PAIRED = new WeakMap<readonly Drawn[], readonly SideRow<Drawn>[]>();
	function pairedRows(shown: readonly Drawn[]): readonly SideRow<Drawn>[] {
		const kept = PAIRED.get(shown);
		if (kept !== undefined) return kept;
		const rows = sideBySide(shown, sideOf);
		PAIRED.set(shown, rows);
		return rows;
	}

	/** The line a drawn row stands for, to say where it belongs: a white-space change's removed line. */
	function lineOf(item: Drawn): ShownLineView {
		return item.kind === 'line' ? item.line : item.removed;
	}

	function sideOf(item: Drawn): LineSide {
		if (item.kind === 'quiet') return 'both';
		const line = item.line;
		switch (line.kind) {
			case 'context':
				return 'both';
			case 'deleted':
				return 'old';
			case 'added':
				return 'new';
		}
	}

	/** The lines that start a run of another group's changes, with that group, to say where once. */
	const NOTES = new WeakMap<readonly Drawn[], ReadonlyMap<Drawn, GroupKeyView>>();
	function notesOf(shown: readonly Drawn[]): ReadonlyMap<Drawn, GroupKeyView> {
		const kept = NOTES.get(shown);
		if (kept !== undefined) return kept;
		const notes = new SvelteMap<Drawn, GroupKeyView>();
		for (const [i, item] of shown.entries()) {
			const group = startsElsewhere(shown, i);
			if (group !== undefined) notes.set(item, group);
		}
		NOTES.set(shown, notes);
		return notes;
	}

	function name(group: GroupKeyView): string {
		return viewer.groupWithKey(group)?.name ?? 'another group';
	}

	/** A run of changes that belong to another group starts here: say where, once. */
	function startsElsewhere(items: readonly Drawn[], i: number): GroupKeyView | undefined {
		const item = items[i];
		if (item === undefined) return undefined;
		const line = lineOf(item);
		if (line.kind === 'context' || line.home.kind !== 'elsewhere') return undefined;
		const previous = items[i - 1];
		const before = previous === undefined ? undefined : lineOf(previous);
		if (
			before !== undefined &&
			before.kind !== 'context' &&
			before.home.kind === 'elsewhere' &&
			JSON.stringify(before.home.group) === JSON.stringify(line.home.group)
		)
			return undefined;
		return line.home.group;
	}

	function isFresh(line: ShownLineView): boolean {
		return line.kind !== 'context' && line.home.kind === 'here' && line.home.fresh;
	}

	/**
	 * Opens hidden lines. The button stays usable while they come, so focus never
	 * drops out of it (a press while they come does nothing more); when the lines
	 * are open and the button has gone, focus goes to what opens the rest of the
	 * same lines, or, when none are left, to the file's name.
	 */
	async function open(b: number, direction: Direction): Promise<void> {
		await viewer.openLines(at, b, direction);
		await tick();
		if (document.activeElement !== null && document.activeElement !== document.body) return;
		const rest = document.getElementById(`part-${String(at)}-block-${String(b)}`);
		const next =
			rest?.querySelector('button') ?? document.getElementById(`part-${String(at)}-toggle`);
		next?.focus();
	}

	/** The height of one row, as the styles below draw it: 1.25rem. */
	const ROW_HEIGHT = 20;

	/** The chunks of long hunks drawn so far (`chunks.ts`); the first of each always is. */
	const drawn = new SvelteSet<string>();

	/** Draws a chunk of rows once it comes near the screen. */
	function drawWhenNear(element: HTMLElement, key: string) {
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					drawn.add(key);
					observer.disconnect();
				}
			},
			{ rootMargin: '1500px 0px' }
		);
		observer.observe(element);
		return {
			destroy() {
				observer.disconnect();
			}
		};
	}

	/** A line's colours: a removed line's from the old side, any other's from the new; none for muted lines. */
	function runsOf(line: ShownLineView) {
		if (colours === undefined) return undefined;
		switch (line.kind) {
			case 'context':
				return colours.new.get(line.new);
			case 'deleted':
				return line.home.kind === 'here' ? colours.old.get(line.old) : undefined;
			case 'added':
				return line.home.kind === 'here' ? colours.new.get(line.new) : undefined;
		}
	}

	function isElsewhere(line: ShownLineView): boolean {
		return line.kind !== 'context' && line.home.kind === 'elsewhere';
	}
	// ── Commenting from a line ──────────────────────────────────────────────────
	//
	// Each line's number is the control that comments on it or flags it, as
	// GitHub's + is: pressed, it opens a small menu under the line, Comment and
	// Flag, for the lines taken (DESIGN 8.1); the `c` and `f` keys do either at
	// once, through a `diffdelver:raise` event on the number. Dragging over numbers, or Shift
	// with a press or the arrow keys, takes a run of lines on one side. The
	// numbers are one stop for Tab in each file, and the arrow keys move among
	// them (`gutter-lines.ts`). One set of listeners on the table serves every
	// line, so a line costs no more to draw than its number did.

	/** The line the keyboard is on. */
	let cursor = $state.raw<GutterLine>();
	/** Where the run of lines being taken started, on the cursor's side. */
	let from = $state<LineNumber>();
	/** The pointer dragging over the numbers. */
	let drag = $state<number>();
	/** A browser let in by a link pressed these lines: say how to turn comments on, under them. */
	let asking = $state.raw<LineSelection>();
	/** The lines whose menu, Comment or Flag, is open under them. */
	let menu = $state.raw<LineSelection>();
	let menuElement = $state<HTMLElement>();
	let buildingGutter = $state(false);
	const gutter = $derived(buildingGutter ? new GutterLines(gutterRows()) : undefined);

	function numberOn(item: Drawn | undefined, side: Side): LineNumber | undefined {
		if (item?.kind === 'quiet')
			return numberOnLine(side === 'old' ? item.removed : item.added, side);
		return numberOnLine(item?.line, side);
	}

	function numberOnLine(line: ShownLineView | undefined, side: Side): LineNumber | undefined {
		return side === 'old'
			? line?.kind === 'added'
				? undefined
				: line?.old
			: line?.kind === 'deleted'
				? undefined
				: line?.new;
	}

	/** The same code rows the table draws, with chunk positions from the line model. */
	function* gutterRows(includeElsewhere = false): Iterable<GutterRow> {
		for (const [b, block] of blocks.entries()) {
			if (block.kind === 'hidden') {
				yield* openedContext(block);
			} else if (block.kind === 'hunk' || (includeElsewhere && block.shown)) {
				const shown = viewer.drawnLines(block);
				if (block.kind === 'hunk' && wholeHunkHidden(shown) !== undefined) continue;
				const rows = split ? pairedRows(shown) : shown;
				for (const [at, row] of rows.entries()) {
					const chunk = `${String(b)}:${String(Math.floor(at / ROWS_PER_CHUNK) * ROWS_PER_CHUNK)}`;
					if ('kind' in row) yield { old: numberOn(row, 'old'), new: numberOn(row, 'new'), chunk };
					else yield { old: numberOn(row.old, 'old'), new: numberOn(row.new, 'new'), chunk };
				}
			}
		}
	}
	$effect(() => {
		const target = bookmarkLine;
		if (target === undefined) return;
		for (const row of gutterRows(true)) {
			if (row[target.side] !== target.line) continue;
			if (row.chunk !== undefined) drawn.add(row.chunk);
			break;
		}
	});

	let table: HTMLTableElement;
	/** The run of lines taken so far: more than the one line the keyboard is on. */
	const taken = $derived(
		cursor === undefined || from === undefined || (from === cursor.line && drag === undefined)
			? undefined
			: selectionBetween(cursor.side, from, cursor.line)
	);

	/** What this file has on the version shown: saved comments, and comments being written. */
	const here = $derived(comments.on(viewer.version, path));

	/** What is drawn under a line: a saved comment, one being written, or how to turn comments on. */
	type Under =
		| { readonly kind: 'saved'; readonly key: string; readonly comment: DraftCommentView }
		| { readonly kind: 'writing'; readonly key: string; readonly writing: Writing }
		| { readonly kind: 'asking'; readonly key: string; readonly lines: LineSelection }
		| { readonly kind: 'menu'; readonly key: string; readonly lines: LineSelection };
	const under = $derived(
		byLastLine<Under>(
			[
				...here.saved.map((comment): Under => ({
					kind: 'saved',
					key: `saved:${String(comment.id)}`,
					comment
				})),
				...here.writing.map((writing): Under => ({
					kind: 'writing',
					key: `writing:${String(writing.key)}`,
					writing
				})),
				...(asking === undefined || canReview
					? []
					: [{ kind: 'asking', key: 'asking', lines: asking } satisfies Under]),
				...(menu === undefined || !canReview
					? []
					: [{ kind: 'menu', key: 'menu', lines: menu } satisfies Under])
			],
			(item) =>
				item.kind === 'saved'
					? item.comment.anchor
					: item.kind === 'writing'
						? item.writing.place.anchor
						: item.lines
		)
	);

	/** What is drawn under a row, by the numbers it shows; undefined, as nearly always, for nothing. */
	function underRow(
		old: LineNumber | undefined,
		now: LineNumber | undefined
	): readonly Under[] | undefined {
		if (under.size === 0) return undefined;
		const before = old === undefined ? undefined : under.get(lineKey('old', old));
		const after = now === undefined ? undefined : under.get(lineKey('new', now));
		return before === undefined ? after : after === undefined ? before : [...before, ...after];
	}

	/**
	 * How many saved comments are on unchanged lines a block still folds away:
	 * the block says so, since nothing else in the diff would.
	 */
	function foldedComments(block: Extract<BlockState, { kind: 'hidden' }>): number {
		if (here.saved.length === 0) return 0;
		const first = block.new.first + block.top.length;
		const last = block.new.last - block.bottom.length;
		const window = bookmarkContext(block);
		const offset = block.new.first - block.old.first;
		let count = 0;
		for (const { anchor } of here.saved) {
			const line = anchor.side === 'new' ? anchor.last : anchor.last + offset;
			if (line < first || line > last) continue;
			// A side's lines map onto the block only where the block has that side's numbers.
			if (anchor.side === 'old' && (anchor.last < block.old.first || anchor.last > block.old.last))
				continue;
			if (!window.some((opened) => opened.new === line)) count += 1;
		}
		return count;
	}

	/** Whether a line is among those taken, or those a comment being written is on. */
	function isMarked(side: Side, line: LineNumber): boolean {
		if (
			inSelection(taken, side, line) ||
			inSelection(asking, side, line) ||
			inSelection(menu, side, line)
		)
			return true;
		for (const writing of here.writing) {
			if (inSelection(writing.place.anchor, side, line)) return true;
		}
		return false;
	}

	// Once this browser may write, the comment asked for while it could not is started.
	$effect(() => {
		const lines = asking;
		if (lines === undefined || !canReview) return;
		asking = undefined;
		comments.start({ version: viewer.version, anchor: { path, ...lines } });
	});

	interface Pressed extends GutterLine {
		readonly button: HTMLButtonElement;
	}

	/** The line whose number an event was on, if it was on one. */
	function lineAt(target: EventTarget | null): Pressed | undefined {
		const button = target instanceof Element ? target.closest('button.pick-line') : null;
		if (!(button instanceof HTMLButtonElement) || !table.contains(button)) return undefined;
		const [sideText = '', lineText = ''] = (button.dataset['readingLine'] ?? '').split(':');
		const side = parseSide(sideText);
		const line = parseLineNumber(Number(lineText));
		return side.ok && line.ok ? { side: side.value, line: line.value, button } : undefined;
	}

	function buttonFor(line: GutterLine): HTMLButtonElement | null {
		return table.querySelector(
			`button.pick-line[data-reading-line="${line.side}:${String(line.line)}"]`
		);
	}

	/**
	 * The one number Tab stops at: the line the keyboard was last on, or the
	 * first. Kept on the element itself and not in each line's markup, so
	 * moving it costs two elements and not every line of the file.
	 */
	let tabStop: HTMLButtonElement | undefined;
	function stopAt(button: HTMLButtonElement | null): void {
		if (button === null || button === tabStop) return;
		if (tabStop !== undefined) tabStop.tabIndex = -1;
		button.tabIndex = 0;
		tabStop = button;
	}

	// Rows come and go as lines are opened and chunks drawn: there is always a stop.
	$effect(() => {
		if (!canComment) return;
		const keep = (): void => {
			if (tabStop?.isConnected === true) return;
			tabStop = undefined;
			const kept = cursor === undefined ? null : buttonFor(cursor);
			stopAt(kept ?? table.querySelector<HTMLButtonElement>('button.pick-line'));
		};
		keep();
		const body = table.tBodies[0];
		if (body === undefined) return;
		const observer = new MutationObserver(keep);
		observer.observe(body, { childList: true });
		return () => {
			observer.disconnect();
		};
	});

	/** Moves the keyboard's line, taking the lines between when asked to and on the same side. */
	function move(next: GutterLine, extend: boolean): void {
		if (!extend || cursor?.side !== next.side || from === undefined) from = next.line;
		cursor = next;
	}

	/** The lines taken, when `line` is among them, or else `line` alone; the run taken is let go. */
	function linesFor(line: GutterLine): LineSelection {
		const alone = selectionBetween(line.side, line.line, line.line);
		const lines = inSelection(taken, line.side, line.line) ? (taken ?? alone) : alone;
		cursor = { side: line.side, line: line.line };
		from = line.line;
		return lines;
	}

	/** Opens the menu, Comment or Flag, for the lines taken, or for this line alone. */
	async function compose(line: GutterLine): Promise<void> {
		const lines = linesFor(line);
		if (!canReview) {
			asking = lines;
			return;
		}
		menu = lines;
		await tick();
		// The whole menu on the screen, clear of the bar at the foot of the page.
		menuElement?.scrollIntoView({ block: 'nearest' });
		menuElement?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
	}

	/** Comments on the lines, or flags them, at once: from the menu, or the `c` and `f` keys. */
	function raise(lines: LineSelection, kind: 'comment' | 'flag'): void {
		menu = undefined;
		if (!canReview) {
			asking = lines;
			return;
		}
		const place = { version: viewer.version, anchor: { path, ...lines } };
		if (kind === 'comment') {
			comments.start(place);
			return;
		}
		void comments.flag(place).then(async (flag) => {
			// Saved, the flag and the way to finish appear: the flag stays on the screen.
			await tick();
			const shown =
				flag === undefined
					? buttonFor({ side: lines.side, line: lines.last })
					: table.querySelector(`[data-comment="${String(flag.id)}"]`);
			shown?.scrollIntoView({ block: 'nearest' });
		});
	}

	/** Puts the menu away, and the keyboard back on the line it was opened from. */
	async function closeMenu(lines: LineSelection): Promise<void> {
		menu = undefined;
		await tick();
		afterBox(lines);
	}

	// The `c` and `f` keys on a line's number ask for one of the two at once.
	$effect(() => {
		const onRaise = (event: Event): void => {
			const line = lineAt(event.target);
			const kind: unknown = event instanceof CustomEvent ? event.detail : undefined;
			if (line === undefined || (kind !== 'comment' && kind !== 'flag')) return;
			raise(linesFor(line), kind);
		};
		table.addEventListener('diffdelver:raise', onRaise);
		return () => {
			table.removeEventListener('diffdelver:raise', onRaise);
		};
	});

	async function drawAndFocus(
		line: GutterLine & { readonly chunk: string | undefined }
	): Promise<void> {
		if (line.chunk !== undefined) drawn.add(line.chunk);
		await tick();
		if (cursor === line) buttonFor(line)?.focus();
	}

	function onFocus(event: FocusEvent): void {
		const line = lineAt(event.target);
		if (line === undefined) return;
		stopAt(line.button);
		// Tab came to it, or the page put the keyboard here: this is where it is now.
		if (cursor?.side !== line.side || cursor.line !== line.line) {
			move({ side: line.side, line: line.line }, false);
		}
	}

	async function onKey(event: KeyboardEvent): Promise<void> {
		const line = lineAt(event.target);
		if (line === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
		const key = event.key;
		if (key === 'Escape' && taken !== undefined) {
			event.preventDefault();
			from = line.line;
			return;
		}
		if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'ArrowLeft' && key !== 'ArrowRight')
			return;
		event.preventDefault();
		buildingGutter = true;
		const target = gutter?.destination(line, key);
		if (target === undefined) return;
		move(target, event.shiftKey);
		await drawAndFocus(target);
	}

	/** A press with the mouse or a pen starts a drag; a touch scrolls the page, and its tap is a click. */
	function beginDrag(event: PointerEvent): void {
		const line = lineAt(event.target);
		if (line === undefined || event.button !== 0 || !event.isPrimary) return;
		if (event.pointerType === 'touch') return;
		event.preventDefault();
		drag = event.pointerId;
		move({ side: line.side, line: line.line }, event.shiftKey);
		line.button.focus({ preventScroll: true });
		line.button.setPointerCapture(event.pointerId);
	}

	function dragOver(event: PointerEvent): void {
		if (event.pointerId !== drag) return;
		const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest('td.number');
		if (cell === null || cell === undefined || !table.contains(cell)) return;
		const line = lineAt(cell.querySelector('button.pick-line'));
		if (line !== undefined && line.side === cursor?.side && line.line !== cursor.line) {
			move({ side: line.side, line: line.line }, true);
		}
	}

	/** The click that follows a drag is the same press, already answered. */
	let dragged = false;

	/** The drag is over: the box opens for what it took. */
	function endDrag(event: PointerEvent): void {
		if (event.pointerId !== drag) return;
		drag = undefined;
		dragged = true;
		if (cursor !== undefined) void compose(cursor);
	}

	function onClick(event: MouseEvent): void {
		const line = lineAt(event.target);
		if (line === undefined) return;
		const answered = dragged && event.detail > 0;
		dragged = false;
		if (answered) return;
		// Enter or Space, the `c` key, a touch, or a screen reader's press.
		if (event.shiftKey) move({ side: line.side, line: line.line }, true);
		void compose(line);
	}

	/** Where the keyboard goes when what was under a row has gone: the number it was opened from. */
	function afterBox(lines: LineSelection): void {
		if (document.activeElement !== null && document.activeElement !== document.body) return;
		(buttonFor({ side: lines.side, line: lines.last }) ?? tabStop)?.focus();
	}
</script>

{#snippet lineNumber(side: Side, line: LineNumber | undefined, main = false)}
	{#if line !== undefined}
		{#if canComment}
			{@const marked = isMarked(side, line)}
			<button
				type="button"
				class="pick-line"
				class:main
				class:marked
				tabindex="-1"
				data-reading-line={`${side}:${line}`}
				aria-label="Comment on or flag line {line}, {side === 'old' ? 'before' : 'after'}"
				aria-pressed={marked ? 'true' : undefined}
			>
				{line}
			</button>
		{:else}
			<span data-reading-line={`${side}:${line}`}>{line}</span>
		{/if}
	{/if}
{/snippet}

{#snippet underneath(old: LineNumber | undefined, now: LineNumber | undefined)}
	{@const items = underRow(old, now)}
	{#if items !== undefined}
		<tr class="under">
			<td colspan={columns}>
				{#each items as item (item.key)}
					{#if item.kind === 'saved'}
						<SavedComment
							{comments}
							comment={item.comment}
							now={comments.now}
							shown={viewer.version}
							open={canComment}
							{showNewer}
							ongone={() => {
								afterBox(item.comment.anchor);
							}}
						/>
					{:else if item.kind === 'writing'}
						<CommentBox
							{comments}
							writing={item.writing}
							version={viewer.version}
							open={canComment}
							where="lines"
							{showNewer}
							onclosed={() => {
								afterBox(item.writing.place.anchor);
							}}
						/>
					{:else if item.kind === 'menu'}
						{@const lines = item.lines}
						{@const words = describeCommentLines(lines)}
						<!-- Escape anywhere in the menu puts it away: one listener for its buttons. -->
						<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
						<div
							class="line-menu"
							role="group"
							aria-label="{words}: comment or flag"
							data-line-menu
							bind:this={menuElement}
							onkeydown={(event) => {
								if (event.key !== 'Escape') return;
								event.preventDefault();
								void closeMenu(lines);
							}}
						>
							<span>{words}</span>
							<button
								type="button"
								data-raise="comment"
								aria-label="Comment on {words}"
								onclick={() => {
									raise(lines, 'comment');
								}}
							>
								Comment
							</button>
							<button
								type="button"
								data-raise="flag"
								aria-label="Flag {words} to look at again"
								onclick={async () => {
									raise(lines, 'flag');
									await tick();
									afterBox(lines);
								}}
							>
								Flag
							</button>
							<button
								type="button"
								onclick={() => {
									void closeMenu(lines);
								}}
							>
								Cancel
							</button>
						</div>
					{:else}
						<div class="asking">
							<ReviewAccess diff={viewer.id} what="comments" />
							<button
								type="button"
								onclick={async () => {
									const lines = item.lines;
									asking = undefined;
									await tick();
									afterBox(lines);
								}}
							>
								Not now
							</button>
						</div>
					{/if}
				{/each}
			</td>
		</tr>
	{/if}
{/snippet}

{#snippet row(line: ShownLineView)}
	<tr
		class={line.kind}
		class:elsewhere={isElsewhere(line)}
		class:fresh={isFresh(line)}
		data-current-match={holdsCurrent(line) ? '' : undefined}
	>
		<td class="number">
			{@render lineNumber(
				'old',
				line.kind === 'added' ? undefined : line.old,
				line.kind === 'deleted'
			)}
		</td>
		<td class="number">
			{@render lineNumber('new', line.kind === 'deleted' ? undefined : line.new, true)}
		</td>
		{#if hasFresh}
			<td class="badge">
				{#if isFresh(line)}<span class="new">
						new<span class="visually-hidden"> since version {previousVersion}</span>
					</span>{/if}
			</td>
		{/if}
		<td class="marker">
			{#if line.kind === 'added'}<span aria-hidden="true">+</span><span class="visually-hidden">
					Added
				</span>{:else if line.kind === 'deleted'}<span aria-hidden="true">−</span><span
					class="visually-hidden"
				>
					Removed
				</span>{/if}
		</td>
		<td
			class="code"
			use:drawLine={{
				text: line.text,
				changed: line.kind !== 'context',
				runs: runsOf(line),
				marks: marksOn(line)
			}}
		></td>
	</tr>
	{#if line.noNewlineAtEnd}
		<tr class="note">
			<td class="number"></td>
			<td class="number"></td>
			<td colspan={columns - 2} class="eof">No newline at end of file</td>
		</tr>
	{/if}
	{@render underneath(
		line.kind === 'added' ? undefined : line.old,
		line.kind === 'deleted' ? undefined : line.new
	)}
{/snippet}

{#snippet quietRow(removed: ShownLineView, added: ShownLineView)}
	<!-- A change of white space only, hidden: drawn as the unchanged line it now is. -->
	<tr
		class="context quiet"
		class:elsewhere={isElsewhere(added)}
		class:fresh={isFresh(removed) || isFresh(added)}
		data-current-match={holdsCurrent(added) || holdsCurrent(removed) ? '' : undefined}
	>
		<td class="number">
			{@render lineNumber('old', removed.kind === 'deleted' ? removed.old : undefined)}
		</td>
		<td class="number">
			{@render lineNumber('new', added.kind === 'added' ? added.new : undefined, true)}
		</td>
		{#if hasFresh}
			<td class="badge">
				{#if isFresh(removed) || isFresh(added)}<span class="new">
						new<span class="visually-hidden"> since version {previousVersion}</span>
					</span>{/if}
			</td>
		{/if}
		<td class="marker"><span class="visually-hidden">White space changed</span></td>
		<td
			class="code"
			use:drawLine={{
				text: added.text,
				changed: false,
				runs: runsOf(added),
				marks: marksOn(added)
			}}
		></td>
	</tr>
	{@render underneath(
		removed.kind === 'deleted' ? removed.old : undefined,
		added.kind === 'added' ? added.new : undefined
	)}
{/snippet}

{#snippet where(elsewhere: GroupKeyView)}
	<tr class="note">
		<td colspan={columns} class="where">
			Shown in <a
				href="#{viewer.groupWithKey(elsewhere)?.anchor ?? ''}"
				aria-label="Go to {shownPath(path)} in {name(elsewhere)}"
				onclick={(event) => {
					event.preventDefault();
					ongo(elsewhere);
				}}
			>
				{name(elsewhere)}
			</a>
		</td>
	</tr>
{/snippet}

{#snippet pending(key: string, rows: number)}
	<!-- Drawn when it comes near the screen; until then, the room it will take. -->
	<tr class="pending" aria-hidden="true" use:drawWhenNear={key}>
		<td colspan={columns} style:height="{rows * ROW_HEIGHT}px"></td>
	</tr>
{/snippet}

{#snippet lines(shown: readonly Drawn[], key: string)}
	{#if split}
		{@const rows = pairedRows(shown)}
		{@const notes = notesOf(shown)}
		{#each chunksOf(rows.length) as chunk (chunk.first)}
			{#if chunk.first === 0 || drawn.has(`${key}:${String(chunk.first)}`)}
				{#each rows.slice(chunk.first, chunk.end) as pair, k (k)}
					{@const elsewhere =
						(pair.old === undefined ? undefined : notes.get(pair.old)) ??
						(pair.new === undefined ? undefined : notes.get(pair.new))}
					{#if elsewhere !== undefined}{@render where(elsewhere)}{/if}
					{@render pairRow(pair)}
				{/each}
			{:else}
				{@render pending(`${key}:${String(chunk.first)}`, chunk.end - chunk.first)}
			{/if}
		{/each}
	{:else}
		{#each chunksOf(shown.length) as chunk (chunk.first)}
			{#if chunk.first === 0 || drawn.has(`${key}:${String(chunk.first)}`)}
				{#each shown.slice(chunk.first, chunk.end) as item, k (k)}
					{@const elsewhere = startsElsewhere(shown, chunk.first + k)}
					{#if elsewhere !== undefined}{@render where(elsewhere)}{/if}
					{#if item.kind === 'quiet'}
						{@render quietRow(item.removed, item.added)}
					{:else}
						{@render row(item.line)}
					{/if}
				{/each}
			{:else}
				{@render pending(`${key}:${String(chunk.first)}`, chunk.end - chunk.first)}
			{/if}
		{/each}
	{/if}
{/snippet}

{#snippet cell(item: Drawn | undefined, side: 'old' | 'new')}
	{@const quiet = item?.kind === 'quiet'}
	{@const line =
		item === undefined
			? undefined
			: item.kind === 'line'
				? item.line
				: side === 'old'
					? item.removed
					: item.added}
	{@const kind = line === undefined ? 'empty' : quiet ? 'context' : line.kind}
	{@const cellClass = `cell-${kind}${line !== undefined && isElsewhere(line) ? ' cell-elsewhere' : ''}${line !== undefined && isFresh(line) ? ' cell-fresh' : ''}`}
	<td class="number {cellClass}" class:side-start={side === 'new'}>
		{@render lineNumber(side, numberOnLine(line, side), true)}
	</td>
	{#if hasFresh}
		<td class="badge {cellClass}">
			{#if line !== undefined && isFresh(line)}<span class="new">
					new<span class="visually-hidden"> since version {previousVersion}</span>
				</span>{/if}
		</td>
	{/if}
	<td class="marker {cellClass}">
		{#if quiet}<span class="visually-hidden">
				White space changed
			</span>{:else if line?.kind === 'added'}<span aria-hidden="true">+</span><span
				class="visually-hidden"
			>
				Added
			</span>{:else if line?.kind === 'deleted'}<span aria-hidden="true">−</span><span
				class="visually-hidden"
			>
				Removed
			</span>{/if}
	</td>
	{#if line === undefined}
		<td class="code {cellClass}"></td>
	{:else}
		<td
			class="code {cellClass}"
			data-current-match={holdsCurrent(line) ? '' : undefined}
			use:drawLine={{
				text: line.text,
				changed: !quiet && line.kind !== 'context',
				runs: runsOf(line),
				marks: marksOn(line)
			}}
		></td>
	{/if}
{/snippet}

{#snippet pairRow(pair: SideRow<Drawn>)}
	{@const oldLine =
		pair.old === undefined
			? undefined
			: pair.old.kind === 'line'
				? pair.old.line
				: pair.old.removed}
	{@const newLine =
		pair.new === undefined ? undefined : pair.new.kind === 'line' ? pair.new.line : pair.new.added}
	<tr class="pair">
		{@render cell(pair.old, 'old')}
		{@render cell(pair.new, 'new')}
	</tr>
	{#if oldLine?.noNewlineAtEnd === true || newLine?.noNewlineAtEnd === true}
		<tr class="note">
			<td colspan={sideColumns} class="eof">
				{oldLine?.noNewlineAtEnd === true ? 'No newline at end of file' : ''}
			</td>
			<td colspan={sideColumns} class="eof side-start">
				{newLine?.noNewlineAtEnd === true ? 'No newline at end of file' : ''}
			</td>
		</tr>
	{/if}
	{@render underneath(numberOn(pair.old, 'old'), numberOn(pair.new, 'new'))}
{/snippet}

{#snippet opened(line: OpenLine)}
	{#if split}
		<tr class="pair opened">
			{#each ['old', 'new'] as side (side)}
				<td class="number cell-context" class:side-start={side === 'new'}>
					{@render lineNumber(
						side === 'old' ? 'old' : 'new',
						side === 'old' ? line.old : line.new,
						true
					)}
				</td>
				{#if hasFresh}<td class="badge cell-context"></td>{/if}
				<td class="marker cell-context"></td>
				<td
					class="code cell-context"
					data-current-match={side === 'new' && holdsCurrent(line) ? '' : undefined}
					use:drawLine={{
						text: line.text,
						changed: false,
						runs: colours?.new.get(line.new),
						marks: marksOn(line)
					}}
				></td>
			{/each}
		</tr>
	{:else}
		<tr class="context opened" data-current-match={holdsCurrent(line) ? '' : undefined}>
			<td class="number">{@render lineNumber('old', line.old)}</td>
			<td class="number">{@render lineNumber('new', line.new, true)}</td>
			{#if hasFresh}<td class="badge"></td>{/if}
			<td class="marker"></td>
			<td
				class="code"
				use:drawLine={{
					text: line.text,
					changed: false,
					runs: colours?.new.get(line.new),
					marks: marksOn(line)
				}}
			></td>
		</tr>
	{/if}
	{@render underneath(line.old, line.new)}
{/snippet}

<!-- The listeners are for the line numbers, which are buttons: one set serves them all. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<table
	bind:this={table}
	class="lines"
	class:split
	aria-label="{split ? 'Lines side by side' : 'Lines'} of {shownPath(path)}"
	aria-busy={busy}
	data-selecting-comment={taken === undefined && menu === undefined ? undefined : ''}
	onfocusin={onFocus}
	onkeydown={onKey}
	onclick={onClick}
	onpointerdown={beginDrag}
	onpointermove={dragOver}
	onlostpointercapture={endDrag}
>
	{#if split}
		<colgroup>
			{#each ['old', 'new'] as side (side)}
				<col class="number-column" />
				{#if hasFresh}<col class="badge-column" />{/if}
				<col class="marker-column" />
				<col />
			{/each}
		</colgroup>
		<thead class="visually-hidden">
			<tr>
				<th scope="col">Line before</th>
				{#if hasFresh}<th scope="col">New</th>{/if}
				<th scope="col">Change before</th>
				<th scope="col">Before</th>
				<th scope="col">Line after</th>
				{#if hasFresh}<th scope="col">New</th>{/if}
				<th scope="col">Change after</th>
				<th scope="col">After</th>
			</tr>
		</thead>
	{:else}
		<colgroup>
			<col class="number-column" />
			<col class="number-column" />
			{#if hasFresh}<col class="badge-column" />{/if}
			<col class="marker-column" />
			<col />
		</colgroup>
		<thead class="visually-hidden">
			<tr>
				<th scope="col">Line before</th>
				<th scope="col">Line after</th>
				{#if hasFresh}<th scope="col">New</th>{/if}
				<th scope="col">Change</th>
				<th scope="col">Code</th>
			</tr>
		</thead>
	{/if}
	<tbody>
		{#each blocks as block, b (b)}
			{#if block.kind === 'hidden'}
				{@const saved = bookmarkContext(block)}
				{@const left = hiddenCount(block)}
				{@const before =
					(saved[0]?.new ?? block.new.first + block.top.length + left) -
					block.new.first -
					block.top.length}
				{@const after = left - before}
				{@const isTop = b === 0}
				{@const isEnd = b === blocks.length - 1}
				{#each block.top as line (line.new)}{@render opened(line)}{/each}
				{#if before === 0}
					{#each saved as line (line.new)}{@render opened(line)}{/each}
				{/if}
				{#if left > 0}
					{@const down = nextStep(block, 'down')}
					{@const up = nextStep(block, 'up')}
					{@const heading = blocks[b + 1]?.kind === 'hunk' ? blocks[b + 1] : undefined}
					<tr class="hidden" id="part-{at}-block-{b}">
						<td colspan={columns}>
							<div class="hidden-row">
								<span class="hidden-count">
									{countOf(
										saved.length === 0 || before === 0 ? left : before,
										'unchanged line',
										'unchanged lines'
									)}
									<!-- Lines opened in the middle, around a bookmark or a comment gone to. -->
									{#if saved.length > 0}
										{before === 0 ? 'below these lines' : 'above these lines'}{/if}
								</span>
								{#if foldedComments(block) > 0}
									{@const folded = foldedComments(block)}
									<span class="folded-comments">
										{folded === 1
											? 'One of your comments is on these lines'
											: `${String(folded)} of your comments are on these lines`}
									</span>
								{/if}
								{#if !isTop && down !== undefined && left > EXPANSION_STEP}
									<button type="button" class="open" onclick={() => open(b, 'down')}>
										<span aria-hidden="true">↓</span>
										{EXPANSION_STEP} more<span class="visually-hidden">
											unchanged lines: {down.first} to {down.last}
										</span>
									</button>
								{/if}
								{#if !isEnd && up !== undefined && left > EXPANSION_STEP}
									<button type="button" class="open" onclick={() => open(b, 'up')}>
										<span aria-hidden="true">↑</span>
										{EXPANSION_STEP} more<span class="visually-hidden">
											unchanged lines: {up.first} to {up.last}
										</span>
									</button>
								{/if}
								<button
									type="button"
									class="open"
									aria-label="Show all {countOf(left, 'unchanged line', 'unchanged lines')}{isTop
										? ' above'
										: isEnd
											? ' below'
											: ''}"
									onclick={() => open(b, 'all')}
								>
									Show all
								</button>
								{#if heading !== undefined && heading.kind === 'hunk' && heading.heading !== ''}
									<code class="heading" use:drawLine={{ text: heading.heading, changed: false }}
									></code>
								{/if}
							</div>
							{#if block.problem !== ''}<p class="problem" role="alert">{block.problem}</p>{/if}
						</td>
					</tr>
				{/if}
				{#if before > 0}
					{#each saved as line (line.new)}{@render opened(line)}{/each}
				{/if}
				{#if before > 0 && after > 0}
					<tr class="hidden">
						<td colspan={columns}>
							<div class="hidden-row">
								{countOf(after, 'unchanged line', 'unchanged lines')} below these lines
							</div>
						</td>
					</tr>
				{/if}
				{#each block.bottom as line (line.new)}{@render opened(line)}{/each}
			{:else if block.kind === 'hunk'}
				{@const shown = viewer.drawnLines(block)}
				{@const hidden = wholeHunkHidden(shown)}
				{#if hidden !== undefined}
					<tr class="hidden white-space">
						<td colspan={columns}>
							<div class="hidden-row">
								<span class="hidden-count">
									Only white space changed here: {countOf(hidden, 'change', 'changes')} hidden
								</span>
								<button
									type="button"
									class="open"
									onclick={async () => {
										block.showWhiteSpace = true;
										// The button goes with what it showed; focus stays in the part, on its name.
										await tick();
										document.getElementById(`part-${String(at)}-toggle`)?.focus();
									}}
								>
									Show them<span class="visually-hidden">
										: {countOf(hidden, 'white-space change', 'white-space changes')}
									</span>
								</button>
							</div>
						</td>
					</tr>
				{:else}
					{@render lines(shown, String(b))}
				{/if}
			{:else}
				{@const changed = block.lines.filter((l) => l.kind !== 'context').length}
				<tr class="hidden">
					<td colspan={columns}>
						<div class="hidden-row">
							<span class="hidden-count">
								{countOf(changed, 'changed line', 'changed lines')} here {changed === 1
									? 'is'
									: 'are'} shown in
								{#each block.groups as group, g (g)}{g > 0 ? ', ' : ''}<a
										href="#{viewer.groupWithKey(group)?.anchor ?? ''}"
										aria-label="Go to {shownPath(path)} in {name(group)}"
										onclick={(event) => {
											event.preventDefault();
											ongo(group);
										}}
									>
										{name(group)}
									</a>{/each}
							</span>
							<button
								type="button"
								class="open"
								aria-expanded={block.shown}
								onclick={() => {
									block.shown = !block.shown;
								}}
							>
								{block.shown ? 'Hide them here' : 'Show them here'}
							</button>
						</div>
					</td>
				</tr>
				{#if block.shown}{@render lines(viewer.drawnLines(block), String(b))}{/if}
			{/if}
		{/each}
	</tbody>
</table>

<style>
	table :global(tr[tabindex='-1']) {
		scroll-margin-top: 0.5rem;
	}

	/*
	 * A line's number is the button that comments on it. It looks like the
	 * number it was until the pointer or the keyboard is on its line, when a +
	 * says what pressing does, as on GitHub. A touch screen has neither, and
	 * shows no +: there the number alone is the control, beside the diff's own
	 * + and − which a second + on every line would be taken for.
	 */
	.pick-line {
		position: relative;
		display: block;
		width: 100%;
		margin: 0;
		padding: 0;
		border: 0;
		border-radius: 3px;
		background: none;
		color: inherit;
		font: inherit;
		font-weight: 400;
		line-height: inherit;
		text-align: right;
		cursor: pointer;
	}

	.pick-line::before {
		content: '+';
		position: absolute;
		left: -0.35rem;
		top: 0.125rem;
		width: 1rem;
		height: 1rem;
		border-radius: 3px;
		background: var(--color-accent);
		color: var(--color-background);
		font-family: var(--font-body);
		font-weight: 700;
		line-height: 1rem;
		text-align: center;
		visibility: hidden;
	}

	.pick-line:hover::before,
	.pick-line:focus-visible::before,
	tr:hover .pick-line.main::before {
		visibility: visible;
	}

	.pick-line:hover {
		background: none;
	}

	.pick-line:focus-visible {
		outline-offset: 0;
	}

	.pick-line.marked {
		background: var(--color-selected-button);
		box-shadow: 0 0 0 1px var(--color-focus);
	}

	.under td {
		border-block: 1px solid var(--color-border);
		background: var(--color-subtle);
	}

	.folded-comments {
		color: var(--color-text);
		font-weight: 700;
	}

	.line-menu {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem 0.6rem;
		max-width: 46rem;
		margin: 0.4rem 0.75rem;
		font-family: var(--font-body);
		font-size: 0.875rem;
		line-height: 1.5;
	}

	.line-menu button {
		padding: 0.1rem 0.6rem;
		font-size: 0.8125rem;
	}

	.asking {
		max-width: 46rem;
		margin: 0 0.75rem 0.5rem;
		font-family: var(--font-body);
		font-size: 0.875rem;
		line-height: 1.5;
	}

	.lines {
		width: 100%;
		font-variant-ligatures: none;
		font-feature-settings:
			'calt' 0,
			'liga' 0;
		border-collapse: collapse;
		table-layout: fixed;
		font-family: var(--font-code);
		font-size: 0.8125rem;
		line-height: 1.25rem;
	}

	.number-column {
		width: 3.5rem;
	}

	.badge-column {
		width: 2.75rem;
	}

	.marker-column {
		width: 1.5rem;
	}

	td {
		padding: 0;
		vertical-align: top;
	}

	.number {
		width: 3.5rem;
		padding: 0 0.5rem;
		text-align: right;
		color: var(--color-muted);
		user-select: none;
	}

	.badge {
		width: 2.5rem;
		text-align: center;
	}

	.new {
		font-family: var(--font-body);
		font-size: 0.6875rem;
		font-weight: 700;
		color: var(--color-accent);
		border: 1px solid var(--color-accent);
		border-radius: 1rem;
		padding: 0 0.3rem;
		line-height: 1rem;
	}

	.marker {
		width: 1.5rem;
		text-align: center;
		user-select: none;
	}

	.code {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		tab-size: 4;
		padding-right: 0.75rem;
	}

	.added {
		background: var(--color-diff-added);
	}

	.added .number,
	.added .marker {
		background: var(--color-diff-added-gutter);
		color: var(--color-text);
	}

	.deleted {
		background: var(--color-diff-removed);
	}

	.deleted .number,
	.deleted .marker {
		background: var(--color-diff-removed-gutter);
		color: var(--color-text);
	}

	.elsewhere,
	.elsewhere .number,
	.elsewhere .marker {
		background: var(--color-subtle);
		color: var(--color-muted);
	}

	/* Side by side: each cell is coloured by its own side's line. */
	td.cell-added {
		background: var(--color-diff-added);
	}

	td.cell-added.number,
	td.cell-added.marker {
		background: var(--color-diff-added-gutter);
		color: var(--color-text);
	}

	td.cell-deleted {
		background: var(--color-diff-removed);
	}

	td.cell-deleted.number,
	td.cell-deleted.marker {
		background: var(--color-diff-removed-gutter);
		color: var(--color-text);
	}

	td.cell-empty {
		background: var(--color-subtle);
	}

	td.cell-elsewhere {
		background: var(--color-subtle);
		color: var(--color-muted);
	}

	td.cell-fresh.badge {
		box-shadow: inset 3px 0 0 var(--color-accent);
	}

	.side-start {
		border-left: 1px solid var(--color-border);
	}

	.fresh .badge {
		box-shadow: inset 3px 0 0 var(--color-accent);
	}

	.note td {
		font-family: var(--font-body);
		font-size: 0.75rem;
		color: var(--color-muted);
	}

	.where {
		padding: 0.1rem 0.75rem;
		background: var(--color-subtle);
	}

	.eof {
		font-style: italic;
	}

	.hidden td {
		background: var(--color-info-background);
		font-family: var(--font-body);
		font-size: 0.8125rem;
		color: var(--color-muted);
	}

	.hidden-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
		padding: 0.2rem 0.75rem;
	}

	.open {
		padding: 0 0.5rem;
		font-size: 0.75rem;
	}

	.heading {
		font-size: 0.75rem;
		color: var(--color-text);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.problem {
		margin: 0;
		padding: 0.2rem 0.75rem;
		color: var(--color-removed);
	}
	.code :global(.tab) {
		position: relative;
	}

	.code :global(.tab)::before {
		content: '»';
		position: absolute;
		left: 0;
		color: var(--color-muted);
		opacity: 0.6;
	}

	.code :global(.trailing) {
		background: var(--color-danger-background);
		box-shadow: inset 0 -2px 0 var(--color-removed);
	}

	.lines :global(.escape) {
		border: 1px solid var(--color-border);
		border-radius: 3px;
		padding: 0 1px;
		color: var(--color-muted);
	}
</style>
