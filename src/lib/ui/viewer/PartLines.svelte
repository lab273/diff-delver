<!--
	One part's lines, as GitHub draws a unified diff: a table with the line
	numbers of both sides, a + or − beside each changed line so colour is never
	the only sign, its code, and between hunks the unchanged lines that are
	hidden, with what opens them. Changes that belong to another group are muted
	and say where they are; lines new since the previous version say so.
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
	import { tick } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { chunksOf } from '#lib/core/viewer/chunks.ts';
	import { EXPANSION_STEP, type Direction } from '#lib/core/viewer/expansion.ts';
	import { countOf } from '#lib/core/viewer/words.ts';

	let {
		viewer,
		at,
		blocks,
		path,
		previousVersion,
		ongo,
		colours,
		busy
	}: {
		viewer: Viewer;
		at: PartIndex;
		blocks: BlockState[];
		/** The colours of its lines that have come; undefined to draw them plain. */
		colours: LineColours | undefined;
		/** Whether colours are on their way: the lines say they are busy until they come. */
		busy: boolean;
		path: EscapedPath;
		/** The version before this one, for "new since version 1"; null for a first version. */
		previousVersion: RevisionNumber | null;
		/** Goes to the part of this file in another group. */
		ongo: (group: GroupKeyView) => void;
	} = $props();

	const hasFresh = $derived(
		blocks.some(
			(b) =>
				b.kind === 'hunk' &&
				b.lines.some((l) => l.kind !== 'context' && l.home.kind === 'here' && l.home.fresh)
		)
	);
	const columns = $derived(hasFresh ? 5 : 4);

	function name(group: GroupKeyView): string {
		return viewer.groupWithKey(group)?.name ?? 'another group';
	}

	/** A run of changes that belong to another group starts here: say where, once. */
	function startsElsewhere(lines: readonly ShownLineView[], i: number): GroupKeyView | undefined {
		const line = lines[i];
		if (line === undefined || line.kind === 'context' || line.home.kind !== 'elsewhere')
			return undefined;
		const before = lines[i - 1];
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
</script>

{#snippet row(line: ShownLineView)}
	<tr class={line.kind} class:elsewhere={isElsewhere(line)} class:fresh={isFresh(line)}>
		<td class="number">{line.kind === 'added' ? '' : line.old}</td>
		<td class="number">{line.kind === 'deleted' ? '' : line.new}</td>
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
			use:drawLine={{ text: line.text, changed: line.kind !== 'context', runs: runsOf(line) }}
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

{#snippet lines(shown: readonly ShownLineView[], key: string)}
	{#each chunksOf(shown.length) as chunk (chunk.first)}
		{#if chunk.first === 0 || drawn.has(`${key}:${String(chunk.first)}`)}
			{#each shown.slice(chunk.first, chunk.end) as line, k (k)}
				{@const elsewhere = startsElsewhere(shown, chunk.first + k)}
				{#if elsewhere !== undefined}
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
				{/if}
				{@render row(line)}
			{/each}
		{:else}
			<!-- Drawn when it comes near the screen; until then, the room it will take. -->
			<tr class="pending" aria-hidden="true" use:drawWhenNear={`${key}:${String(chunk.first)}`}>
				<td colspan={columns} style:height="{(chunk.end - chunk.first) * ROW_HEIGHT}px"></td>
			</tr>
		{/if}
	{/each}
{/snippet}

{#snippet opened(line: OpenLine)}
	<tr class="context opened">
		<td class="number">{line.old}</td>
		<td class="number">{line.new}</td>
		{#if hasFresh}<td class="badge"></td>{/if}
		<td class="marker"></td>
		<td
			class="code"
			use:drawLine={{ text: line.text, changed: false, runs: colours?.new.get(line.new) }}
		></td>
	</tr>
{/snippet}

<table class="lines" aria-label="Lines of {shownPath(path)}" aria-busy={busy}>
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
				{@render lines(block.lines, String(b))}
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
				{#if block.shown}{@render lines(block.lines, String(b))}{/if}
			{/if}
		{/each}
	</tbody>
</table>

<style>
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
