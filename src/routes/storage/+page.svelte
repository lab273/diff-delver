<!--
	Storage (DESIGN 9.1): what diff delver takes on disk. Each repository's
	store with its real size, the Delves in it by what deleting each would
	free, with Delete, and the database's size. A Delve's figures are
	estimates, measured in the background, so one opened a moment ago may
	have none yet.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { invalidate } from '$app/navigation';
	import { describeApiError } from '#lib/api/client.ts';
	import DeleteDelve from '#lib/ui/DeleteDelve.svelte';
	import type { DeleteTarget } from '#lib/ui/delete-target.ts';
	import Notice from '#lib/ui/Notice.svelte';
	import ReviewAccess from '#lib/ui/ReviewAccess.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let heading: HTMLHeadingElement | undefined = $state();
	let deleting: DeleteTarget | undefined = $state();
	let status = $state('');
	let problem = $state('');
</script>

<svelte:head>
	<title>Storage · diff delver</title>
</svelte:head>

<h1 tabindex="-1" bind:this={heading}>Storage</h1>

<p class="status" role="status">{status}</p>
{#if problem !== ''}
	<Notice tone="danger" heading="The Delve was not deleted">
		<p>{problem}</p>
	</Notice>
{/if}

{#if !data.storage.ok}
	<Notice tone="danger" heading="What diff delver takes on disk cannot be read">
		<p>{describeApiError(data.storage.error)}</p>
	</Notice>
{:else}
	{@const storage = data.storage.value}
	<p class="lead">
		diff delver keeps a copy of what each Delve shows, one store for each repository, so it can be
		read after the repository has moved on. What each Delve takes is an estimate: Delves of a
		repository share what they have in common, and only what a Delve alone holds is freed when it is
		deleted.
	</p>
	{#if storage.stores.length === 0}
		<p>Nothing is stored yet.</p>
	{/if}
	{#each storage.stores as store, index (index)}
		<section aria-labelledby="store-{String(index)}">
			<h2 id="store-{String(index)}">
				{store.repository} <span class="size">{store.onDiskText} on disk</span>
			</h2>
			{#if store.delves.length === 0}
				<p class="none">No Delves. What is left is freed the next time it is tidied.</p>
			{:else}
				<ul class="delves">
					{#each store.delves as diff (diff.id)}
						<li>
							<a href={resolve('/diffs/[id]', { id: diff.id })}>{diff.title}</a>
							<span class="figure" title={diff.disk?.inFull}>
								{diff.disk?.text ?? 'Not measured yet'}
							</span>
							{#if data.canReview}
								<button
									type="button"
									aria-label="Delete {diff.title} in {store.repository}"
									onclick={() => {
										problem = '';
										deleting = {
											id: diff.id,
											name: `${diff.title} in ${store.repository}`,
											disk: diff.disk
										};
									}}
								>
									Delete
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/each}
	<p class="database">
		Your Delves’ details, comments and reviews: {storage.databaseText} on disk.
	</p>
	{#if !data.canReview}
		<ReviewAccess diff={null} what="deleting" />
	{/if}
{/if}

<DeleteDelve
	bind:target={deleting}
	ondeleted={async (said: string) => {
		status = said;
		await invalidate('app:diffs');
		heading?.focus();
	}}
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

	.lead {
		margin: 0 0 1rem;
		max-width: 48rem;
	}

	h2 {
		font-size: 1.125rem;
		margin: 1.5rem 0 0.5rem;
	}

	.size,
	.figure,
	.none,
	.database {
		color: var(--color-muted);
		font-size: 0.875rem;
		font-weight: 400;
	}

	.delves {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: 6px;
	}

	.delves li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 1rem;
		padding: 0.5rem 1rem;
	}

	.delves li + li {
		border-top: 1px solid var(--color-border);
	}

	.delves button {
		margin-left: auto;
	}

	.database {
		margin: 1.5rem 0 0;
	}
</style>
