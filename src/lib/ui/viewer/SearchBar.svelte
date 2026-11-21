<!--
	The search box of a diff's page (DESIGN 8.3): text to find in every file of
	the diff, how many matches there are and in how many files, the one the
	person is on, the way to the next and the previous, and the options, each a
	switch that is remembered. It stays at the top of the screen while the
	person moves from match to match.

	In the box, Enter goes to the next match and Shift+Enter to the one before
	(the arrow keys too), and Escape closes the search; the page's other keys
	do not fire while typing. Control+F (Command+F) pressed there is the
	browser's own find, as GitHub does it.
-->
<script lang="ts">
	import type { DiffSearch } from './search.svelte.ts';

	let {
		search,
		busy,
		ontext,
		onstep,
		onclose,
		onoption
	}: {
		search: DiffSearch;
		/** Moving to a match is under way. */
		busy: boolean;
		ontext: (text: string) => void;
		onstep: (forward: boolean) => void;
		onclose: () => void;
		onoption: (option: 'match-case' | 'changed-only' | 'skip-closed', on: boolean) => void;
	} = $props();

	/** The count, where the current match is (said only to screen readers), and why a move fell short. */
	const status = $derived(search.status);
	/** Why a move fell short, after the count when there is one. */
	const note = $derived(
		status.count !== '' && status.note !== '' ? `. ${status.note}` : status.note
	);

	function onKeydown(event: KeyboardEvent): void {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		switch (event.key) {
			case 'Enter':
				event.preventDefault();
				onstep(!event.shiftKey);
				return;
			case 'ArrowDown':
				event.preventDefault();
				onstep(true);
				return;
			case 'ArrowUp':
				event.preventDefault();
				onstep(false);
				return;
			default:
				return;
		}
	}
</script>

<div
	class="search-bar"
	role="presentation"
	onkeydown={(event) => {
		// Escape anywhere in the search closes it, and the box is not cleared first.
		if (event.key === 'Escape') {
			event.preventDefault();
			onclose();
		}
	}}
>
	<div
		class="search"
		role="search"
		aria-label="Search the diff"
		aria-busy={busy || search.found.kind === 'searching'}
	>
		<div class="row">
			<input
				id="search-input"
				type="search"
				autocomplete="off"
				spellcheck="false"
				aria-label="Search the diff"
				aria-describedby="search-status"
				placeholder="Search the diff"
				value={search.text}
				oninput={(event) => {
					ontext(event.currentTarget.value);
				}}
				onkeydown={onKeydown}
			/>
			<button
				type="button"
				onclick={() => {
					onstep(false);
				}}
				aria-label="Previous match"
			>
				<span aria-hidden="true">↑</span> Previous
			</button>
			<button
				type="button"
				onclick={() => {
					onstep(true);
				}}
				aria-label="Next match"
			>
				<span aria-hidden="true">↓</span> Next
			</button>
			<button type="button" class="quiet" onclick={onclose}>
				Close <kbd aria-hidden="true">Esc</kbd>
			</button>
		</div>
		<div class="row options" role="group" aria-label="Search options">
			<button
				type="button"
				aria-pressed={search.matchCase}
				onclick={() => {
					onoption('match-case', !search.matchCase);
				}}
			>
				Match case
			</button>
			<button
				type="button"
				aria-pressed={search.changedOnly}
				onclick={() => {
					onoption('changed-only', !search.changedOnly);
				}}
			>
				Changed lines only
			</button>
			<button
				type="button"
				aria-pressed={search.skipClosed}
				onclick={() => {
					onoption('skip-closed', !search.skipClosed);
				}}
			>
				Skip closed files
			</button>
		</div>
		<p id="search-status" class="status" role="status">
			{status.count}<span class="visually-hidden">{status.where}</span>{note}
		</p>
	</div>
</div>

<style>
	.search-bar {
		position: sticky;
		top: 0;
		z-index: 2;
	}

	.search {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin: 0 0 1rem;
		padding: 0.6rem 0.75rem;
		background: var(--color-background);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		font-size: 0.875rem;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
	}

	input {
		flex: 1 1 14rem;
		min-width: 0;
		padding: 0.3rem 0.6rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-background);
		color: var(--color-text);
		font-family: var(--font-code);
		font-size: 0.875rem;
	}

	.options button {
		font-size: 0.75rem;
		padding: 0.1rem 0.6rem;
	}

	button[aria-pressed='true'] {
		background: var(--color-selected-button);
		border-color: var(--color-accent);
	}

	.quiet {
		font-weight: 400;
	}

	kbd {
		font-size: 0.75rem;
		border: 1px solid currentColor;
		border-radius: 4px;
		padding: 0 0.3rem;
		opacity: 0.8;
	}

	.status {
		margin: 0;
		min-height: 1.3rem;
		color: var(--color-muted);
	}
</style>
