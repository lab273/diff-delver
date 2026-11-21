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
	import type { CommentDraft } from './draft-comment.svelte.ts';
	import { parseLineNumber, type LineNumber } from '#lib/core/line-number.tiny.ts';
	import { parseSide, type Side } from '#lib/core/side.tiny.ts';
	import type { PartMarks } from './search.svelte.ts';

	let {
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
		draft,
		canComment
	}: {
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
		draft: CommentDraft;
		canComment: boolean;
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
	type GutterLine = { readonly side: Side; readonly line: LineNumber };
	let cursor = $state.raw<GutterLine>();
	let first = $state<LineNumber>();
	let drag = $state<number>();
	let selectionProblem = $state(false);
	let commentButton = $state<HTMLButtonElement>();
	let table: HTMLTableElement;
	const canPick = $derived(
		canComment && !draft.saving && (draft.location === undefined || draft.replacing)
	);
	const picking = $derived(canPick && cursor !== undefined);
	const range = $derived(
		cursor === undefined || first === undefined
			? undefined
			: {
					side: cursor.side,
					first: first < cursor.line ? first : cursor.line,
					last: first > cursor.line ? first : cursor.line
				}
	);
	const selected = $derived(
		picking
			? range
			: draft.location?.version === viewer.version && draft.location.anchor.path === path
				? draft.location.anchor
				: undefined
	);

	function lineOfButton(button: HTMLButtonElement | null | undefined): GutterLine | undefined {
		const side = parseSide(button?.dataset['side'] ?? '');
		const line = parseLineNumber(Number(button?.dataset['line']));
		return side.ok && line.ok ? { side: side.value, line: line.value } : undefined;
	}

	function buttonFor(line: GutterLine): HTMLButtonElement | null {
		return table.querySelector(
			`button.pick-line[data-side="${line.side}"][data-line="${String(line.line)}"]`
		);
	}

	async function startComment(): Promise<void> {
		// Buttons are rendered only for the file where the reviewer is selecting.
		for (const cell of table.querySelectorAll<HTMLTableCellElement>('td.number[data-side]')) {
			const side = parseSide(cell.dataset['side'] ?? '');
			const line = parseLineNumber(Number(cell.textContent));
			if (!side.ok || !line.ok) continue;
			const initial = { side: side.value, line: line.value };
			cursor = initial;
			first = line.value;
			selectionProblem = false;
			await tick();
			buttonFor(initial)?.focus();
			return;
		}
		selectionProblem = true;
	}

	async function stopPicking(): Promise<void> {
		cursor = undefined;
		first = undefined;
		drag = undefined;
		await tick();
		commentButton?.focus();
	}

	function compose(): void {
		if (!picking || range === undefined) return;
		draft.compose({ version: viewer.version, anchor: { path, ...range } });
		cursor = undefined;
		first = undefined;
		drag = undefined;
	}

	function move(next: GutterLine, extend: boolean): void {
		if (!extend || cursor?.side !== next.side) first = next.line;
		cursor = next;
	}

	/** Vertical movement follows the same side, drawing the next chunk if it is still a placeholder. */
	async function vertical(
		button: HTMLButtonElement,
		side: Side,
		step: number
	): Promise<HTMLButtonElement | undefined> {
		const items = Array.from(
			table.querySelectorAll<HTMLElement>(
				`button.pick-line[data-side="${side}"], [data-pending-key]`
			)
		);
		const position = items.indexOf(button);
		if (position < 0) return undefined;
		for (let i = position + step; i >= 0 && i < items.length; i += step) {
			const next = items[i];
			if (next instanceof HTMLButtonElement) return next;
			const key = next?.dataset['pendingKey'];
			if (key !== undefined) {
				drawn.add(key);
				await tick();
				return vertical(button, side, step);
			}
		}
		return undefined;
	}

	/** In a unified diff a replacement may show the other side on a separate row. */
	function across(button: HTMLButtonElement, side: Side): HTMLButtonElement | undefined {
		const row = button.closest('tr')?.rowIndex;
		if (row === undefined) return undefined;
		let nearest: HTMLButtonElement | undefined;
		let distance = Infinity;
		for (const candidate of table.querySelectorAll<HTMLButtonElement>(
			`button.pick-line[data-side="${side}"]`
		)) {
			const at = candidate.closest('tr')?.rowIndex;
			if (at === undefined) continue;
			const steps = Math.abs(at - row);
			if (steps === 0) return candidate;
			if (steps >= distance) continue;
			distance = steps;
			nearest = candidate;
		}
		return nearest;
	}

	async function arrow(event: KeyboardEvent, line: GutterLine): Promise<void> {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		const key = event.key;
		if (key === 'Escape') {
			event.preventDefault();
			await stopPicking();
			return;
		}
		const button = event.currentTarget;
		if (!(button instanceof HTMLButtonElement)) return;
		let next: HTMLButtonElement | null | undefined;
		switch (key) {
			case 'ArrowUp':
			case 'ArrowDown':
				event.preventDefault();
				next = await vertical(button, line.side, key === 'ArrowUp' ? -1 : 1);
				break;
			case 'ArrowLeft':
			case 'ArrowRight': {
				event.preventDefault();
				const side = key === 'ArrowLeft' ? 'old' : 'new';
				if (line.side === side) return;
				next = across(button, side);
				break;
			}
			default:
				return;
		}
		const target = lineOfButton(next);
		if (target === undefined || !picking) return;
		move(target, event.shiftKey);
		next?.focus();
	}

	function beginDrag(event: PointerEvent, line: GutterLine): void {
		const button = event.currentTarget;
		if (event.button !== 0 || !event.isPrimary || !(button instanceof HTMLButtonElement)) return;
		event.preventDefault();
		drag = event.pointerId;
		move(line, event.shiftKey);
		button.focus({ preventScroll: true });
		button.setPointerCapture(event.pointerId);
	}

	function dragOver(event: PointerEvent): void {
		if (event.pointerId !== drag) return;
		const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest('td.number');
		if (cell === null || cell === undefined || !table.contains(cell)) return;
		const line = lineOfButton(cell.querySelector('button.pick-line'));
		if (line?.side === cursor?.side && line !== undefined && line.line !== cursor?.line) {
			move(line, true);
		}
	}

	function endDrag(event: PointerEvent): void {
		if (event.pointerId !== drag) return;
		drag = undefined;
		if (cursor !== undefined) buttonFor(cursor)?.focus({ preventScroll: true });
	}
</script>

{#snippet lineNumber(side: Side, line: LineNumber | undefined)}
	{#if line !== undefined}
		{@const marked = selected?.side === side && line >= selected.first && line <= selected.last}
		{#if picking}
			<button
				type="button"
				class="pick-line"
				data-side={side}
				data-line={line}
				tabindex={cursor?.side === side && cursor.line === line ? 0 : -1}
				aria-label="{side === 'old' ? 'Before' : 'After'}, line {line}"
				aria-pressed={marked}
				onkeydown={(event) => arrow(event, { side, line })}
				onclick={(event) => {
					if (event.detail === 0) compose();
				}}
				onpointerdown={(event) => {
					beginDrag(event, { side, line });
				}}
				onpointermove={dragOver}
				onlostpointercapture={endDrag}
			>
				{line}
			</button>
		{:else if marked}
			<span class="marked">{line}</span>
		{:else}
			{line}
		{/if}
	{/if}
{/snippet}

{#snippet row(line: ShownLineView)}
	<tr
		class={line.kind}
		class:elsewhere={isElsewhere(line)}
		class:fresh={isFresh(line)}
		data-current-match={holdsCurrent(line) ? '' : undefined}
	>
		<td class="number" data-side="old">
			{@render lineNumber('old', line.kind === 'added' ? undefined : line.old)}
		</td>
		<td class="number" data-side="new">
			{@render lineNumber('new', line.kind === 'deleted' ? undefined : line.new)}
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
{/snippet}

{#snippet quietRow(removed: ShownLineView, added: ShownLineView)}
	<!-- A change of white space only, hidden: drawn as the unchanged line it now is. -->
	<tr
		class="context quiet"
		class:elsewhere={isElsewhere(added)}
		class:fresh={isFresh(removed) || isFresh(added)}
		data-current-match={holdsCurrent(added) || holdsCurrent(removed) ? '' : undefined}
	>
		<td class="number" data-side="old">
			{@render lineNumber('old', removed.kind === 'deleted' ? removed.old : undefined)}
		</td>
		<td class="number" data-side="new">
			{@render lineNumber('new', added.kind === 'added' ? added.new : undefined)}
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
	<tr class="pending" aria-hidden="true" data-pending-key={key} use:drawWhenNear={key}>
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
	<td class="number {cellClass}" data-side={side} class:side-start={side === 'new'}>
		{@render lineNumber(
			side,
			side === 'old'
				? line?.kind === 'added'
					? undefined
					: line?.old
				: line?.kind === 'deleted'
					? undefined
					: line?.new
		)}
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
{/snippet}

{#snippet opened(line: OpenLine)}
	{#if split}
		<tr class="pair opened">
			{#each ['old', 'new'] as side (side)}
				<td class="number cell-context" data-side={side} class:side-start={side === 'new'}>
					{@render lineNumber(side === 'old' ? 'old' : 'new', side === 'old' ? line.old : line.new)}
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
			<td class="number" data-side="old">{@render lineNumber('old', line.old)}</td>
			<td class="number" data-side="new">{@render lineNumber('new', line.new)}</td>
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
{/snippet}

{#if canComment}
	<div class="comment-action">
		{#if picking}
			<button type="button" onclick={compose}>Write comment</button>
			<button type="button" onclick={stopPicking}>Cancel selection</button>
			<p>
				Drag line numbers on one side, or use arrows to move, Shift+↑/↓ to extend, and Enter to
				write.
			</p>
		{:else}
			<button
				type="button"
				aria-disabled={!canPick}
				bind:this={commentButton}
				onclick={() => {
					if (canPick) void startComment();
				}}
			>
				Comment on lines
			</button>
			{#if selectionProblem}<p role="status">
					Show some lines in this file before choosing a range.
				</p>{/if}
		{/if}
	</div>
{/if}

<table
	bind:this={table}
	class="lines"
	class:split
	aria-label="{split ? 'Lines side by side' : 'Lines'} of {shownPath(path)}"
	aria-busy={busy}
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
				{@const left = hiddenCount(block)}
				{@const isTop = b === 0}
				{@const isEnd = b === blocks.length - 1}
				{#each block.top as line (line.new)}{@render opened(line)}{/each}
				{#if left > 0}
					{@const down = nextStep(block, 'down')}
					{@const up = nextStep(block, 'up')}
					{@const heading = blocks[b + 1]?.kind === 'hunk' ? blocks[b + 1] : undefined}
					<tr class="hidden" id="part-{at}-block-{b}">
						<td colspan={columns}>
							<div class="hidden-row">
								<span class="hidden-count">
									{countOf(left, 'unchanged line', 'unchanged lines')}
								</span>
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
	.comment-action {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3rem 0.65rem;
	}
	.comment-action p {
		margin: 0;
	}
	.marked,
	.pick-line[aria-pressed='true'] {
		background: var(--color-selected-button);
		outline: 1px solid var(--color-focus);
		border-radius: 3px;
	}
	.pick-line {
		touch-action: none;
		padding: 0 0.2rem;
		font: inherit;
		line-height: 1rem;
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

	/* Code coloured by language; comments are in italics too, so they stand apart without colour. */
	.code :global(.code-keyword) {
		color: var(--color-code-keyword);
	}

	.code :global(.code-string) {
		color: var(--color-code-string);
	}

	.code :global(.code-comment) {
		color: var(--color-code-comment);
		font-style: italic;
	}

	.code :global(.code-function) {
		color: var(--color-code-function);
	}

	.code :global(.code-constant) {
		color: var(--color-code-constant);
	}

	.code :global(.code-parameter) {
		color: var(--color-code-parameter);
	}

	.lines :global(.escape) {
		border: 1px solid var(--color-border);
		border-radius: 3px;
		padding: 0 1px;
		color: var(--color-muted);
	}
</style>
