<!--
	One Delve as a list shows it: its title, a link to it, whether it is open,
	its repository, when it was last active, its size, how far its review has
	got, and whether a comment being written on it in this tab is not saved yet.
	The list of Delves and the panel on a Delve's page both draw this, so a Delve
	is described in one way.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import type { DiffSummary } from '#lib/api/schemas.ts';
	import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
	import { describeTimeAgo } from '#lib/core/time-ago.ts';
	import DiffSize from '#lib/ui/DiffSize.svelte';
	import { hasUnsavedWords } from '#lib/ui/viewer/kept-comments.ts';

	let { diff, now }: { diff: DiffSummary; now: Timestamp } = $props();
</script>

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
{#if hasUnsavedWords(diff.id)}
	<p class="unsaved">A comment you were writing here is not saved yet. Open it to go on.</p>
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
