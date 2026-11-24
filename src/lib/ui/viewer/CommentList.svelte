<!--
	Every comment of the reviewer's draft, in one place above the diff: how many
	there are, each with its file, its lines and when it was written, on
	whichever version it was written; and whatever is being written whose lines
	are not on the page, so it is never out of reach.
-->
<script lang="ts">
	import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
	import CommentBox from './CommentBox.svelte';
	import SavedComment from './SavedComment.svelte';
	import type { Comments } from './comments.svelte.ts';

	let {
		comments,
		version,
		open,
		diffHidden,
		showNewer,
		control = $bindable()
	}: {
		comments: Comments;
		/** The version the page shows. */
		version: RevisionNumber;
		/** Whether the Delve is open. */
		open: boolean;
		/** The diff's lines are not shown, as in the list of files: every box waits here. */
		diffHidden: boolean;
		showNewer: () => void;
		control?: HTMLButtonElement | undefined;
	} = $props();

	let expanded = $state(false);
	const panelId = $props.id();
	const saved = $derived(comments.saved);
	/** What is being written and has no place among the lines on the page now. */
	const waiting = $derived(comments.writing.filter((w) => diffHidden || w.inDiff === 0));
</script>

<section class="comments" aria-label="Draft comments">
	<button
		type="button"
		bind:this={control}
		aria-expanded={expanded}
		aria-controls={panelId}
		onclick={() => (expanded = !expanded)}
	>
		Draft comments{saved === undefined ? '' : ` (${String(saved.length)})`}
	</button>
	{#each waiting as writing (writing.key)}
		<CommentBox
			{comments}
			{writing}
			{version}
			{open}
			docked
			{showNewer}
			onclosed={() => {
				control?.focus();
			}}
		/>
	{/each}
	<div
		id={panelId}
		class="panel"
		aria-busy={comments.loading && saved === undefined}
		hidden={!expanded}
	>
		{#if comments.problem !== ''}
			<p role="alert">{comments.problem} Close and open Draft comments to try again.</p>
		{:else if saved === undefined}
			<p role="status">Loading your comments…</p>
		{:else if saved.length === 0}
			<p>
				No comments yet. To write one, press the number of a line in a file below, or press
				<kbd>c</kbd> on a line. Drag over the numbers, or hold Shift with the arrow keys, to take several
				lines.
			</p>
		{:else}
			<ul>
				{#each saved as comment (comment.id)}
					<li><SavedComment {comment} now={comments.now} shown={version} listed /></li>
				{/each}
			</ul>
		{/if}
	</div>
</section>

<style>
	.comments {
		margin-block: 0.75rem;
	}

	.panel p {
		margin-block: 0.5rem;
		max-width: 46rem;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	kbd {
		border: 1px solid var(--color-border);
		border-bottom-width: 2px;
		border-radius: 4px;
		padding: 0 0.3rem;
		font-size: 0.8125rem;
		background: var(--color-subtle);
	}
</style>
