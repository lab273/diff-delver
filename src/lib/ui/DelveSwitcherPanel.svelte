<!--
	The panel that moves a reader between Delves without leaving the page: the
	other Delves, most recently active first, as the list of Delves shows them,
	with a box to find one by name when there are more than a handful; the way
	to open something new in this Delve's repository; and the list of all of
	them. Each is a link. The list is asked for when the panel opens, not with
	the page. Escape or Close puts it away and focus goes back where it was.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { untrack } from 'svelte';
	import { describeApiError, type ApiError } from '#lib/api/client.ts';
	import type { DiffList } from '#lib/api/schemas.ts';
	import type { ReportId } from '#lib/core/report-id.tiny.ts';
	import { findDelves, offersFinding } from '#lib/core/reports/switch-delves.ts';
	import type { Result } from '#lib/core/result.ts';
	import ChooseLink from '#lib/ui/ChooseLink.svelte';
	import DelveEntry from '#lib/ui/DelveEntry.svelte';
	import { pageClient } from '#lib/ui/client.ts';
	import type { DelveSwitcher } from '#lib/ui/delve-switcher.svelte.ts';

	let {
		switcher,
		current
	}: {
		switcher: DelveSwitcher;
		/** The Delve the page shows, which the panel leaves out. */
		current: ReportId | undefined;
	} = $props();

	let dialog: HTMLDialogElement | undefined = $state();
	let heading: HTMLHeadingElement | undefined = $state();
	let findBox: HTMLInputElement | undefined = $state();
	let listed = $state.raw<Result<DiffList, ApiError> | undefined>();
	let typed = $state('');
	/** Counts the times the panel was opened, so an answer to an earlier opening is dropped. */
	let asked = 0;

	const delves = $derived(
		listed?.ok === true ? listed.value.diffs.filter((diff) => diff.kind === 'diff') : []
	);
	const others = $derived(delves.filter((diff) => diff.id !== current));
	const finding = $derived(offersFinding(others.length));
	const found = $derived(finding ? findDelves(others, typed) : others);
	/** This Delve's repository, or every known one when the page shows no Delve it could read. */
	const repositories = $derived.by(() => {
		if (listed?.ok !== true) return [];
		const here = delves.find((diff) => diff.id === current);
		const all = listed.value.repositories;
		return here === undefined ? all : all.filter((r) => r.directory === here.directory);
	});

	async function ask(): Promise<void> {
		asked += 1;
		const mine = asked;
		listed = undefined;
		typed = '';
		const answer = await pageClient().listDiffs();
		if (mine !== asked) return;
		listed = answer;
	}

	$effect(() => {
		if (dialog === undefined) return;
		if (switcher.open && !dialog.open) {
			dialog.showModal();
			heading?.focus();
			untrack(() => void ask());
		} else if (!switcher.open && dialog.open) {
			dialog.close();
		}
	});

	// With many Delves, typing a name is the quick way: the box takes focus once it is there,
	// unless the reader has already moved on.
	// The box is unbound again when the panel is put away, so it may be there or not.
	$effect(() => {
		if (finding && document.activeElement === heading) findBox?.focus();
	});
</script>

<dialog
	bind:this={dialog}
	aria-labelledby="other-delves-heading"
	aria-busy={switcher.open && listed === undefined}
	oncancel={() => {
		// Escape: put away at once, so a key pressed straight after works on the page.
		switcher.open = false;
	}}
	onclose={() => {
		switcher.open = false;
	}}
>
	<h2 id="other-delves-heading" tabindex="-1" bind:this={heading}>Other Delves</h2>
	{#if switcher.open}
		{#if listed === undefined}
			<p role="status">Finding your Delves…</p>
		{:else if !listed.ok}
			<p role="alert">Your Delves cannot be listed. {describeApiError(listed.error)}</p>
		{:else}
			{@const now = listed.value.now}
			{#if finding}
				<label for="find-delve">Find a Delve by name</label>
				<input
					id="find-delve"
					type="search"
					autocomplete="off"
					bind:this={findBox}
					bind:value={typed}
					onkeydown={(event) => {
						// In a search box the browser's Escape only empties it: here it puts the panel away, as anywhere in it.
						if (event.key === 'Escape') switcher.open = false;
					}}
				/>
				<p class="count" role="status">
					{found.length === others.length
						? `${String(others.length)} other Delves`
						: found.length === 0
							? 'No Delve has that in its name or its repository’s. Try fewer letters.'
							: found.length === 1
								? '1 Delve found'
								: `${String(found.length)} Delves found`}
				</p>
			{/if}
			{#if others.length === 0}
				<p class="none">
					{current === undefined ? 'No Delves yet.' : 'This is your only Delve so far.'}
				</p>
			{:else if found.length > 0}
				<ul class="delves" aria-label="Other Delves">
					{#each found as diff (diff.id)}
						<li><DelveEntry {diff} {now} /></li>
					{/each}
				</ul>
			{/if}
			{#if repositories.length > 0}
				<h3>Open something else</h3>
				<ul class="ways">
					{#each repositories as repository (repository.directory)}
						<li><ChooseLink {repository} /></li>
					{/each}
				</ul>
			{/if}
		{/if}
	{/if}
	<div class="actions">
		<a href={resolve('/')}>See all your Delves</a>
		<button
			type="button"
			onclick={() => {
				switcher.open = false;
			}}
		>
			Close
		</button>
	</div>
</dialog>

<style>
	dialog {
		width: min(36rem, calc(100% - 2rem));
		max-height: calc(100% - 4rem);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-background);
		color: var(--color-text);
		padding: 1rem 1.25rem;
	}

	dialog::backdrop {
		background: rgb(0 0 0 / 40%);
	}

	h2 {
		margin: 0 0 0.75rem;
		font-size: 1.125rem;
	}

	h2:focus {
		outline: none;
	}

	h3 {
		margin: 1rem 0 0.25rem;
		font-size: 1rem;
	}

	p {
		margin: 0 0 0.75rem;
	}

	label {
		display: block;
		font-size: 0.875rem;
		font-weight: 700;
		margin-bottom: 0.25rem;
	}

	input {
		width: 100%;
		box-sizing: border-box;
		font: inherit;
		padding: 0.25rem 0.5rem;
	}

	.count,
	.none {
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.count {
		margin: 0.25rem 0 0.5rem;
	}

	.delves {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: 6px;
	}

	.delves li {
		padding: 0.6rem 0.75rem;
	}

	.delves li + li {
		border-top: 1px solid var(--color-border);
	}

	.ways {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.ways li + li {
		margin-top: 0.25rem;
	}

	.actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 1rem;
	}
</style>
