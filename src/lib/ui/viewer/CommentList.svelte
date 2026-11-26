<!--
	Every comment and flag of the reviewer's draft, in one place above the
	diff: how many there are, each with its file, its lines and when it was written, on
	whichever version it was written; and whatever is being written whose lines
	are not on the page, so it is never out of reach.
-->
<script lang="ts">
	import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
	import CommentBox from './CommentBox.svelte';
	import SavedComment from './SavedComment.svelte';
	import type { DraftCommentView } from '#lib/api/schemas.ts';
	import { describeCommentLines } from '#lib/core/review/draft-comment.ts';
	import { shownPath } from '#lib/core/shown-path.tiny.ts';
	import PathText from '#lib/ui/PathText.svelte';
	import type { CommentPlace, Comments, Writing } from './comments.svelte.ts';

	let {
		comments,
		version,
		open,
		diffHidden,
		showNewer,
		ongo,
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
		/** Goes to lines of the version shown, in the diff: a saved comment's, or a box's. */
		ongo: (place: CommentPlace, what: DraftCommentView | Writing) => void;
		control?: HTMLButtonElement | undefined;
	} = $props();

	let expanded = $state(false);
	const panelId = $props.id();
	const saved = $derived(comments.saved);
	/** What is being written and has no place among the lines on the page now. */
	const waiting = $derived(
		comments.writing.filter((w) => w.inList === 0 && (diffHidden || w.inDiff === 0))
	);
	/** What is being written under its lines, somewhere in the diff: a way back to each. */
	const underLines = $derived(comments.writing.filter((w) => !diffHidden && w.inDiff > 0));
</script>

<section class="comments" aria-label="Draft comments">
	<button
		type="button"
		bind:this={control}
		aria-expanded={expanded}
		aria-controls={panelId}
		onclick={() => (expanded = !expanded)}
	>
		Draft comments{saved === undefined
			? ''
			: comments.flagCount === 0
				? ` (${String(comments.commentCount)})`
				: ` (${String(comments.commentCount)}) and flags (${String(comments.flagCount)})`}
	</button>
	{#if underLines.length > 0}
		<ul class="unsaved" aria-label="Comments not saved yet">
			{#each underLines as writing (writing.key)}
				{@const lines = describeCommentLines(writing.place.anchor)}
				<li>
					<span>Not saved yet:</span>
					<span class="path"><PathText path={writing.place.anchor.path} /></span>
					<span>{lines}</span>
					<button
						type="button"
						aria-label="Go to the comment you are writing: {shownPath(
							writing.place.anchor.path
						)}, {lines}"
						onclick={() => {
							ongo(writing.place, writing);
						}}
					>
						Go to it
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	{#each waiting as writing (writing.key)}
		<CommentBox
			{comments}
			{writing}
			{version}
			{open}
			where="waiting"
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
		<!-- Drawn only while open, so a box in it is one the reviewer can see. -->
		{#if !expanded}
			<!-- Closed. -->
		{:else if comments.problem !== ''}
			<p role="alert">{comments.problem} Close and open Draft comments to try again.</p>
		{:else if saved === undefined}
			<p role="status">Loading your comments…</p>
		{:else if saved.length === 0}
			<p>
				No comments yet. To write one, press the number of a line in a file below, or press
				<kbd>c</kbd> on a line. Drag over the numbers, or hold Shift with the arrow keys, to take
				several lines. To flag lines to look at again, press <kbd>f</kbd> on one.
			</p>
		{:else}
			<ul>
				{#each saved as comment (comment.id)}
					<li>
						<SavedComment
							{comments}
							{comment}
							now={comments.now}
							shown={version}
							{open}
							listed
							{showNewer}
							ongo={() => {
								ongo(comment, comment);
							}}
							ongone={() => {
								control?.focus();
							}}
						/>
					</li>
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

	.unsaved li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem 0.6rem;
		margin-top: 0.5rem;
		font-size: 0.875rem;
	}

	.unsaved .path {
		font-family: var(--font-code);
		font-size: 0.8125rem;
		overflow-wrap: anywhere;
	}

	.unsaved button {
		padding: 0.1rem 0.6rem;
		font-size: 0.8125rem;
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
