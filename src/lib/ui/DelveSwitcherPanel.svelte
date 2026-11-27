<!--
	The panel that opens another Delve without leaving the page: the other
	Delves, most recently active first, as the list of Delves shows them,
	with a box to find one by name when there are more than a handful; the way
	to open something new in this Delve's repository; and the list of all of
	them. Each is a link. The list is asked for when the panel opens, not with
	the page. The list of Delves scrolls inside it, so the way to something new,
	the list of all Delves and Close stay in sight under it. Escape or Close puts
	it away and focus goes back where it was.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { untrack } from 'svelte';
	import { describeApiError, type ApiError } from '#lib/api/client.ts';
	import type { DiffList } from '#lib/api/schemas.ts';
	import type { ReportId } from '#lib/core/report-id.tiny.ts';
	import { findDelves, folderToShow, offersFinding } from '#lib/core/reports/switch-delves.ts';
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
	const known = $derived(listed?.ok === true ? listed.value.repositories : []);
	const found = $derived(finding ? findDelves(others, typed, known) : others);
	/** This Delve's repository, or every known one when the page shows no Delve it could read. */
	/** The Delve the page shows, as listed; none on a page whose Delve could not be shown. */
	const here = $derived(delves.find((diff) => diff.id === current));
	const repositories = $derived.by(() => {
		if (listed?.ok !== true) return [];
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
	aria-labelledby="open-another-heading"
	aria-busy={switcher.open && listed === undefined}
	oncancel={() => {
		// Escape: put away at once, so a key pressed straight after works on the page.
		switcher.open = false;
	}}
	onclose={() => {
		switcher.open = false;
	}}
>
	<h2 id="open-another-heading" tabindex="-1" bind:this={heading}>Open another Delve</h2>
	{#if switcher.open}
		{#if listed === undefined}
			<p role="status">Finding your Delves…</p>
		{:else if !listed.ok}
			<p role="alert">Your Delves cannot be listed. {describeApiError(listed.error)}</p>
		{:else}
			{@const now = listed.value.now}
			{@const theirName = here === undefined ? 'Your Delves' : 'Your other Delves'}
			{#if finding}
				<div class="find">
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
							? `${String(others.length)} ${here === undefined ? 'Delves' : 'other Delves'}`
							: found.length === 0
								? 'No Delve has that in its name or its repository’s. Try fewer letters.'
								: found.length === 1
									? '1 Delve found'
									: `${String(found.length)} Delves found`}
					</p>
				</div>
			{/if}
			<!-- The list scrolls inside the panel, so what is under it stays in sight. -->
			<section class="theirs" aria-labelledby="their-heading">
				<h3 id="their-heading">{theirName}</h3>
				{#if others.length === 0}
					<p class="none">
						{here === undefined ? 'No Delves yet.' : 'This is your only Delve so far.'}
					</p>
				{:else if found.length > 0}
					<ul class="delves" aria-labelledby="their-heading">
						{#each found as diff (diff.id)}
							<li>
								<DelveEntry
									{diff}
									{now}
									folder={folderToShow(diff, known)}
									pullRequestLink={false}
								/>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
			{#if repositories.length > 0}
				<section class="new" aria-labelledby="new-heading">
					<h3 id="new-heading">
						Something new{here === undefined ? '' : ` in ${here.repository}`}
					</h3>
					<ul class="ways">
						{#each repositories as repository (repository.directory)}
							<li><ChooseLink {repository} /></li>
						{/each}
					</ul>
				</section>
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
		box-sizing: border-box;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-background);
		color: var(--color-text);
		padding: 1rem 1.25rem;
	}

	/* A column whose list takes what room is left and scrolls: only while open, or it would show closed. */
	dialog[open] {
		display: flex;
		flex-direction: column;
	}

	.theirs {
		min-height: 6rem;
		overflow-y: auto;
	}

	.find,
	.new,
	.actions {
		flex: none;
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
		margin: 0 0 0.25rem;
		font-size: 1rem;
	}

	.new h3 {
		margin-top: 1rem;
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
