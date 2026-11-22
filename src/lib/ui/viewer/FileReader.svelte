<script lang="ts">
	import type { FileReaderView } from '#lib/api/schemas.ts';
	import { describeApiError } from '#lib/api/client.ts';
	import { visibleText } from '#lib/core/hidden-characters.ts';
	import { LONGEST_LINE_TO_COLOUR } from '#lib/core/highlight/limits.ts';
	import { lineNumberOf, type LineNumber } from '#lib/core/line-number.tiny.ts';
	import type { ColourRun } from '#lib/core/highlight/colour-run.ts';
	import type { EscapedPath } from '#lib/core/path-bytes.ts';
	import type { ReportId } from '#lib/core/report-id.tiny.ts';
	import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
	import type { Side } from '#lib/core/side.tiny.ts';
	import { FILE_PAGE_LINES } from '#lib/core/viewer/file-reader.ts';
	import { pageClient } from '#lib/ui/client.ts';
	import PathText from '#lib/ui/PathText.svelte';
	import { drawLine } from './draw-line.ts';

	let {
		id,
		version,
		path,
		side,
		colour,
		onclose,
		onswitch,
		onjump
	}: {
		id: ReportId;
		version: RevisionNumber;
		path: EscapedPath;
		side: Side;
		colour: boolean;
		onclose: () => void;
		onswitch: (path: EscapedPath, side: Side) => void;
		onjump: (path: EscapedPath, side: Side, line?: LineNumber) => void;
	} = $props();

	let dialog: HTMLDialogElement | undefined = $state();
	let body: HTMLElement | undefined = $state();
	let first = $state(lineNumberOf(1));
	let file = $state.raw<FileReaderView>();
	let colours = $state.raw<ReadonlyMap<LineNumber, readonly ColourRun[]>>();
	let problem = $state('');
	let loading = $state(true);
	let colouring = $state(false);
	let lineInput = $state<number>();
	const other = $derived(side === 'old' ? 'new' : 'old');

	$effect(() => {
		dialog?.showModal();
	});

	$effect(() => {
		const from = first;
		const last = lineNumberOf(from + FILE_PAGE_LINES - 1);
		const client = pageClient();
		const query = { version, path, side, first: from, last };
		const report = id;
		const withColour = colour;
		const request = new AbortController();
		const abandoned = (): boolean => request.signal.aborted;
		loading = true;
		problem = '';
		colours = undefined;
		colouring = false;
		void client.readFile(report, query).then(async (read) => {
			if (abandoned()) return;
			loading = false;
			if (!read.ok) {
				problem = describeApiError(read.error);
				return;
			}
			file = read.value;
			if (body !== undefined) body.scrollTop = 0;
			if (!withColour || read.value.kind !== 'text' || read.value.lines.length === 0) return;
			colouring = true;
			const spans = [{ first: from, last }];
			const result = await client.readColours(report, {
				version: query.version,
				path: query.path,
				exact: '1',
				old: query.side === 'old' ? spans : [],
				new: query.side === 'new' ? spans : []
			});
			if (abandoned()) return;
			colouring = false;
			const sideColours = result.ok ? result.value[query.side] : null;
			if (sideColours?.kind === 'coloured') {
				colours = new Map(sideColours.lines.map((line) => [line.number, line.runs]));
			}
		});
		return () => {
			request.abort();
		};
	});

	function pageAt(line: number): void {
		if (file === undefined || loading || line < 1 || line > file.lineCount) return;
		first = lineNumberOf(line);
	}

	function jump(event: SubmitEvent): void {
		event.preventDefault();
		if (lineInput !== undefined && Number.isSafeInteger(lineInput)) {
			pageAt(1 + Math.floor((lineInput - 1) / FILE_PAGE_LINES) * FILE_PAGE_LINES);
		}
	}

	function close(event: Event): void {
		event.preventDefault();
		onclose();
	}
</script>

<dialog bind:this={dialog} aria-labelledby="file-reader-heading" oncancel={close}>
	<header>
		<button type="button" onclick={onclose}>Back to Delve</button>
		<h2 id="file-reader-heading"><PathText {path} /></h2>
		<div class="actions">
			<span>{side === 'old' ? 'Base · Before changes' : 'Head · After changes'}</span>
			{#if file?.otherPath}
				{@const destination = file.otherPath}
				<button
					type="button"
					onclick={() => {
						onswitch(destination, other);
					}}
				>
					{other === 'old' ? 'Show base' : 'Show head'}
				</button>
			{/if}
			{#if file?.diffPath}
				{@const destination = file.diffPath}
				<button
					type="button"
					onclick={() => {
						onjump(destination, side);
					}}
				>
					Show in diff
				</button>
			{:else if file !== undefined}
				<span>This file is unchanged in this diff.</span>
			{/if}
		</div>
	</header>
	<div class="reader-body" bind:this={body} aria-busy={loading || colouring}>
		{#if loading}
			<p role="status">Opening file…</p>
		{:else if problem !== ''}
			<p role="alert">{problem}</p>
		{:else if file !== undefined}
			{#if file.kind === 'binary'}
				<p>This is a binary file. It has no text preview.</p>
			{:else if file.kind === 'large'}
				<p>This file is too large to display. The file reader can show files up to 4 MB.</p>
			{:else if file.kind === 'submodule'}
				<p>This is a submodule. Its files belong to a separate repository.</p>
			{:else}
				{#if file.kind === 'symlink'}<p>Symbolic link target</p>{/if}
				{#if file.nonUtf8}<p>Some bytes are outside UTF-8 and appear as �.</p>{/if}
				{#if file.lineCount === 0}<p>This file is empty.</p>{/if}
				{#each file.lines as { number, text, changed } (number)}
					{@const destination = file.diffPath}
					<div class="reader-row" class:changed>
						{#if changed && destination !== null}
							<button
								type="button"
								class="gutter"
								aria-label="Show change at line {number} in the diff"
								onclick={() => {
									onjump(destination, side, number);
								}}
							>
								{side === 'old' ? '−' : '+'}
								{number}
							</button>
						{:else}
							<span class="gutter">{number}</span>
						{/if}
						{#if text.length > LONGEST_LINE_TO_COLOUR}
							<!-- Keep controls visible without creating an unbounded number of spans for one line. -->
							<code class="reader-code">{visibleText(text)}</code>
						{:else}
							<code class="reader-code" use:drawLine={{ text, changed, runs: colours?.get(number) }}
							></code>
						{/if}
					</div>
				{/each}
			{/if}
		{/if}
	</div>
	{#if file !== undefined && file.lineCount > FILE_PAGE_LINES}
		<footer>
			<button
				type="button"
				disabled={first === 1}
				aria-disabled={loading}
				onclick={() => {
					pageAt(first - FILE_PAGE_LINES);
				}}
			>
				Previous lines
			</button>
			<span role="status">
				Lines {first}–{Math.min(file.lineCount, first + FILE_PAGE_LINES - 1)} of {file.lineCount}
			</span>
			<button
				type="button"
				disabled={first + FILE_PAGE_LINES > file.lineCount}
				aria-disabled={loading}
				onclick={() => {
					pageAt(first + FILE_PAGE_LINES);
				}}
			>
				Next lines
			</button>
			<form onsubmit={jump}>
				<label for="reader-line">Go to line</label>
				<input
					id="reader-line"
					type="number"
					min="1"
					max={file.lineCount}
					bind:value={lineInput}
					required
				/>
				<button type="submit">Go</button>
			</form>
		</footer>
	{/if}
</dialog>

<style>
	dialog {
		width: min(80rem, calc(100% - 2rem));
		max-height: calc(100% - 2rem);
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		color: var(--color-text);
		background: var(--color-background);
	}
	dialog[open] {
		display: flex;
		flex-direction: column;
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 40%);
	}
	header,
	footer {
		padding: 0.85rem 1rem;
	}
	header {
		border-bottom: 1px solid var(--color-border);
	}
	h2 {
		margin: 0.6rem 0;
		font-size: 1.15rem;
		overflow-wrap: anywhere;
	}
	.actions,
	footer,
	form {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem 0.85rem;
	}
	.actions {
		color: var(--color-muted);
	}
	.reader-body {
		overflow: auto;
		min-height: 3.25rem;
	}
	.reader-body p {
		margin: 0.85rem 1rem;
	}
	.reader-row {
		display: grid;
		grid-template-columns: 6.5ch 1fr;
		align-items: baseline;
		min-width: max-content;
		font: 0.875rem / 1.55 var(--font-code);
		font-variant-ligatures: none;
		font-feature-settings:
			'calt' 0,
			'liga' 0;
	}
	.reader-code {
		white-space: pre;
		tab-size: 4;
		padding-inline: 0.65rem;
	}
	.gutter {
		padding-inline: 0.2rem 0.5rem;
		text-align: right;
		color: var(--color-muted);
		font: inherit;
	}
	.reader-code :global(.escape) {
		border: 1px solid var(--color-border);
		border-radius: 3px;
		color: var(--color-muted);
		padding: 0 1px;
	}
	button.gutter {
		color: var(--color-text);
	}
	.changed {
		background: var(--color-subtle);
	}
	footer {
		border-top: 1px solid var(--color-border);
	}
	form input {
		width: 7ch;
	}
</style>
