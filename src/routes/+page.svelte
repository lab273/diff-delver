<!--
	Home: every diff that has been opened, most recently active first, or, for a
	newcomer, the one command that opens one.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { invalidate } from '$app/navigation';
	import { describeApiError } from '#lib/api/client.ts';
	import type { ListedDiff } from '#lib/api/schemas.ts';
	import { folderToShow } from '#lib/core/reports/switch-delves.ts';
	import ChooseLink from '#lib/ui/ChooseLink.svelte';
	import CopyCommand from '#lib/ui/CopyCommand.svelte';
	import DeleteDelve from '#lib/ui/DeleteDelve.svelte';
	import type { DeleteTarget } from '#lib/ui/delete-target.ts';
	import DelveEntry from '#lib/ui/DelveEntry.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import ReviewAccess from '#lib/ui/ReviewAccess.svelte';
	import { RUN_COMMAND } from '#lib/ui/run-command.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let heading: HTMLHeadingElement | undefined = $state();
	let deleting: DeleteTarget | undefined = $state();
	let status = $state('');
	let problem = $state('');

	function nameOf(diff: ListedDiff): string {
		return diff.kind === 'diff' ? `${diff.title} in ${diff.repository}` : 'this damaged entry';
	}

	async function deleted(said: string): Promise<void> {
		status = said;
		await invalidate('app:diffs');
		// The row that had focus is gone: start again from the top of the list.
		heading?.focus();
	}
</script>

<svelte:head>
	<title>diff delver</title>
</svelte:head>

<h1 tabindex="-1" bind:this={heading}>Your Delves</h1>

<p class="status" role="status">{status}</p>
{#if problem !== ''}
	<Notice tone="danger" heading="The Delve was not deleted">
		<p>{problem}</p>
	</Notice>
{/if}

{#if !data.listed.ok}
	<Notice tone="danger" heading="Your Delves cannot be listed">
		<p>{describeApiError(data.listed.error)}</p>
	</Notice>
{:else if data.listed.value.diffs.length === 0}
	<section class="empty" aria-labelledby="first-step">
		<p>No Delves yet.</p>
		<h2 id="first-step">Start a Delve</h2>
		<p>In a terminal, go to a git repository with changes and run:</p>
		<CopyCommand command={RUN_COMMAND} label="Copy the command" />
		<p>
			It opens the uncommitted changes, or your branch compared with the main branch, here in your
			browser. Nothing is written to your repository.
		</p>
	</section>
{:else}
	{@const now = data.listed.value.now}
	{@const repositories = data.listed.value.repositories}
	<ul class="diffs">
		{#each data.listed.value.diffs as diff, index (diff.kind === 'diff' ? diff.id : `damaged-${String(index)}`)}
			<li>
				{#if diff.kind === 'diff'}
					<DelveEntry {diff} {now} folder={folderToShow(diff, repositories)} />
				{:else}
					<div class="line">
						<span class="title">A Delve that cannot be read</span>
						<span class="state damaged">Damaged</span>
					</div>
					<p class="details">{diff.problem}</p>
				{/if}
				{#if data.canReview && diff.id !== null}
					{@const id = diff.id}
					<button
						type="button"
						class="delete"
						aria-label="Delete {nameOf(diff)}"
						onclick={() => {
							problem = '';
							deleting = { id, name: nameOf(diff), disk: diff.kind === 'diff' ? diff.disk : null };
						}}
					>
						Delete
					</button>
				{/if}
			</li>
		{/each}
	</ul>
	{#if !data.canReview}
		<ReviewAccess diff={null} what="deleting" />
	{/if}
	<p class="storage">
		<a href={resolve('/storage')}>What your Delves take on disk</a>
	</p>
	<section class="open-more" aria-labelledby="open-more-heading">
		<h2 id="open-more-heading">Open something else</h2>
		<ul>
			{#each repositories as repository (repository.directory)}
				<li><ChooseLink {repository} /></li>
			{/each}
		</ul>
		<p class="more">
			For a repository that is not here yet, run <code>{RUN_COMMAND}</code> in it.
		</p>
	</section>
{/if}

<DeleteDelve
	bind:target={deleting}
	ondeleted={deleted}
	onfailed={(said: string) => {
		problem = said;
	}}
/>

<style>
	h1 {
		margin: 0 0 1rem;
		font-size: 1.75rem;
	}

	h1:focus {
		outline: none;
	}

	.status {
		margin: 0;
	}

	.status:not(:empty) {
		margin-bottom: 1rem;
	}

	.storage {
		margin: 0.75rem 0 0;
		font-size: 0.875rem;
	}

	.open-more h2 {
		font-size: 1.125rem;
		margin: 1.5rem 0 0.5rem;
	}

	.open-more ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.open-more li + li {
		margin-top: 0.25rem;
	}

	.more {
		margin: 0.75rem 0 0;
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.empty h2 {
		font-size: 1.25rem;
		margin: 1.5rem 0 0.5rem;
	}

	.empty p {
		margin: 0.5rem 0;
	}

	.empty > p:first-child {
		color: var(--color-muted);
	}

	.diffs {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: 6px;
	}

	.diffs li {
		position: relative;
		padding: 0.75rem 7rem 0.75rem 1rem;
	}

	.diffs li + li {
		border-top: 1px solid var(--color-border);
	}

	.line {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.title {
		font-weight: 700;
	}

	.state {
		font-size: 0.75rem;
		font-weight: 700;
		border: 1px solid var(--color-border);
		border-radius: 2rem;
		padding: 0 0.5rem;
	}

	.state.damaged {
		color: var(--color-removed);
		border-color: var(--color-removed);
	}

	.details {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1rem;
		margin: 0.25rem 0 0;
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.delete {
		position: absolute;
		top: 0.75rem;
		right: 1rem;
	}
</style>
