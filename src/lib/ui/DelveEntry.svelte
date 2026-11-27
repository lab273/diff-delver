<!--
	One Delve as a list shows it: its title, a link to it, whether it is open,
	its repository (with its folder, when another repository has the same name),
	for a pull request's Delve a link to the pull request on GitHub,
	when it was last active, its size with its tests apart and its binary
	files, what it takes on disk once measured, with what it shares on hover,
	how far its review has
	got, and whether something being written on it in this tab, a comment or the
	overall review, is not saved yet.
	The list of Delves and the panel on a Delve's page both draw this, so a Delve
	is described in one way.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import type { DiffSummary } from '#lib/api/schemas.ts';
	import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
	import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
	import { describeTimeAgo } from '#lib/core/time-ago.ts';
	import DiffSize from '#lib/ui/DiffSize.svelte';
	import VisibleText from '#lib/ui/VisibleText.svelte';
	import { hasUnsavedWords } from '#lib/ui/viewer/kept-comments.ts';

	let {
		diff,
		now,
		folder
	}: {
		diff: DiffSummary;
		now: Timestamp;
		/** Its repository's folder, when its name alone does not say which repository it is. */
		folder: AbsolutePath | undefined;
	} = $props();
</script>

<div class="line">
	<a class="title" href={resolve('/diffs/[id]', { id: diff.id })}>{diff.title}</a>
	<span class="state {diff.state.kind}">
		{diff.state.kind === 'open' ? 'Open' : 'Closed'}
	</span>
</div>
<p class="details">
	<span>
		{diff.repository}
		{#if folder !== undefined}
			<span class="folder">(<VisibleText text={folder} />)</span>
		{/if}
	</span>
	{#if diff.pullRequest !== null}
		<span>
			<a href={diff.pullRequest.address} target="_blank" rel="external noopener noreferrer">
				{diff.pullRequest.text}
			</a>
		</span>
	{/if}
	<span>Last active {describeTimeAgo(diff.lastActivityAt, now)}</span>
	<span>
		{diff.size.files === 1 ? '1 file' : `${String(diff.size.files)} files`}
		<DiffSize added={diff.size.added} removed={diff.size.removed} tests={diff.size.tests} />
	</span>
	{#if diff.binaryText !== null}
		<span>{diff.binaryText}</span>
	{/if}
	{#if diff.disk !== null}
		<span title={diff.disk.inFull}>{diff.disk.text}</span>
	{/if}
</p>
<p class="progress">{diff.progressText}</p>
{#if hasUnsavedWords(diff.id)}
	<p class="unsaved">Something you were writing here is not saved yet. Open it to go on.</p>
{/if}

<style>
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

	.details {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1rem;
		margin: 0.25rem 0 0;
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.folder {
		overflow-wrap: anywhere;
	}

	.progress {
		margin: 0.25rem 0 0;
		font-size: 0.875rem;
	}

	.unsaved {
		margin: 0.25rem 0 0;
		font-size: 0.875rem;
		font-weight: 700;
	}
</style>
