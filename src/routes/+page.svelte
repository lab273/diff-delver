<!--
	Home: every diff that has been opened, most recently active first, or, for a
	newcomer, the one command that opens one.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { invalidate } from '$app/navigation';
	import { describeApiError } from '#lib/api/client.ts';
	import type { ListedDiff } from '#lib/api/schemas.ts';
	import type { ReportId } from '#lib/core/report-id.tiny.ts';
	import { describeTimeAgo } from '#lib/core/time-ago.ts';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import CopyCommand from '#lib/ui/CopyCommand.svelte';
	import DiffSize from '#lib/ui/DiffSize.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import { pageClient } from '#lib/ui/client.ts';
	import { RUN_COMMAND } from '#lib/ui/run-command.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	interface Deleting {
		readonly id: ReportId;
		readonly name: string;
	}

	let asking = $state(false);
	let heading: HTMLHeadingElement | undefined = $state();
	let deleting: Deleting | undefined = $state();
	let status = $state('');
	let problem = $state('');

	function nameOf(diff: ListedDiff): string {
		return diff.kind === 'diff' ? `${diff.title} in ${diff.repository}` : 'this damaged entry';
	}

	function askToDelete(id: ReportId, name: string): void {
		deleting = { id, name };
		problem = '';
		asking = true;
	}

	async function confirmDelete(): Promise<void> {
		if (deleting === undefined) return;
		const { id, name } = deleting;
		const deleted = await pageClient().deleteDiff(id);
		asking = false;
		deleting = undefined;
		if (!deleted.ok) {
			problem = describeApiError(deleted.error);
			return;
		}
		status =
			deleted.value.problem === null
				? `Deleted ${name}. Its space on disk is freed within an hour.`
				: `Deleted ${name}. ${deleted.value.problem}`;
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
	<ul class="diffs">
		{#each data.listed.value.diffs as diff, index (diff.kind === 'diff' ? diff.id : `damaged-${String(index)}`)}
			<li>
				{#if diff.kind === 'diff'}
					<div class="line">
						<a class="title" href={resolve('/diffs/[id]', { id: diff.id })}>{diff.title}</a>
						<span class="state {diff.state.kind}">
							{diff.state.kind === 'open' ? 'Open' : 'Closed'}
						</span>
					</div>
					<p class="details">
						<span>{diff.repository}</span>
						<span>Last active {describeTimeAgo(diff.lastActivityAt, now)}</span>
						<span>
							{diff.size.files === 1 ? '1 file' : `${String(diff.size.files)} files`}
							<DiffSize added={diff.size.added} removed={diff.size.removed} />
						</span>
					</p>
					<p class="progress">{diff.progressText}</p>
				{:else}
					<div class="line">
						<span class="title">A Delve that cannot be read</span>
						<span class="state damaged">Damaged</span>
					</div>
					<p class="details">{diff.problem}</p>
				{/if}
				{#if diff.id !== null}
					{@const id = diff.id}
					<button
						type="button"
						class="delete"
						aria-label="Delete {nameOf(diff)}"
						onclick={() => {
							askToDelete(id, nameOf(diff));
						}}
					>
						Delete
					</button>
				{/if}
			</li>
		{/each}
	</ul>
	<p class="more">To open another, run <code>{RUN_COMMAND}</code> in its repository.</p>
{/if}

<ConfirmDialog
	bind:open={asking}
	heading="Delete {deleting?.name ?? 'this Delve'}?"
	confirm="Delete"
	onconfirm={confirmDelete}
>
	Everything diff delver keeps about it goes, including what you have marked as reviewed. Your
	repository is not touched. The space it takes on disk is freed within an hour.
</ConfirmDialog>

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

	.more {
		margin: 1rem 0 0;
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

	.state.open {
		color: var(--color-added);
		border-color: var(--color-added);
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

	.progress {
		margin: 0.25rem 0 0;
		font-size: 0.875rem;
	}

	.delete {
		position: absolute;
		top: 0.75rem;
		right: 1rem;
	}
</style>
