<!--
	One saved comment, as the reviewer reads it back: under its lines in the
	diff, or in the list of all comments. Its words are the reviewer's own and
	are drawn as plain text, line breaks kept: nothing in them is read as
	markup, so nothing in them can do anything.

	While the Delve is open its words can be changed in place, in the box they
	were written in, and it can be deleted, which asks first, as deleting does
	everywhere: nothing brings a deleted comment back.
-->
<script lang="ts">
	import type { DraftCommentView } from '#lib/api/schemas.ts';
	import { describeCommentLines } from '#lib/core/review/draft-comment.ts';
	import { describeOtherVersion } from '#lib/core/review/comment-places.ts';
	import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
	import { shownPath } from '#lib/core/shown-path.tiny.ts';
	import { describeTimeAgo } from '#lib/core/time-ago.ts';
	import { tick } from 'svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import PathText from '#lib/ui/PathText.svelte';
	import CommentBox from './CommentBox.svelte';
	import type { Comments, NotDeleted } from './comments.svelte.ts';
	import type { Timestamp } from '#lib/core/timestamp.tiny.ts';

	let {
		comments,
		comment,
		now,
		shown,
		open,
		listed = false,
		ongo,
		showNewer,
		ongone
	}: {
		comments: Comments;
		comment: DraftCommentView;
		/** The daemon's time when the draft was read, to say how long ago; undefined, and it is not said. */
		now: Timestamp | undefined;
		/** The version the page shows. */
		shown: RevisionNumber;
		/** Whether the Delve is open, so the comment can be changed or deleted. */
		open: boolean;
		/** In the list of all comments, where it names its file and says when its lines are elsewhere. */
		listed?: boolean;
		/** From the list: goes to its lines in the diff. Offered when they are in the version shown. */
		ongo?: (() => void) | undefined;
		showNewer: () => void;
		/** After it was deleted and has gone: the keyboard needs somewhere to be. */
		ongone: () => void;
	} = $props();

	let article = $state<HTMLElement>();
	/** The box open on its words, wherever on the page it was opened. */
	const changing = $derived(comments.changing(comment));
	let asking = $state(false);
	let deleting = $state(false);
	let notDeleted = $state.raw<NotDeleted>();

	async function remove(): Promise<void> {
		if (deleting) return;
		deleting = true;
		const refused = await comments.remove(comment, shown);
		deleting = false;
		asking = false;
		notDeleted = refused;
		await tick();
		if (refused === undefined) ongone();
	}

	const elsewhere = $derived(describeOtherVersion(comment.version, shown));

	const lines = $derived(describeCommentLines(comment.anchor));
	/** What it is on, as its buttons name it: its file too, in the list. */
	const name = $derived(listed ? `${shownPath(comment.anchor.path)}, ${lines}` : lines);
	/** "written 5 minutes ago", and "edited just now" once its words were changed. */
	const when = $derived.by(() => {
		if (now === undefined) return '';
		const written = `written ${describeTimeAgo(comment.writtenAt, now)}`;
		return comment.editedAt === null
			? written
			: `${written}, edited ${describeTimeAgo(comment.editedAt, now)}`;
	});
</script>

<article
	bind:this={article}
	class="comment"
	class:listed
	tabindex="-1"
	data-comment={listed ? undefined : comment.id}
	aria-label="Your comment on {listed ? `${shownPath(comment.anchor.path)}, ` : ''}{lines}"
>
	{#if changing !== undefined}
		<CommentBox
			{comments}
			writing={changing}
			version={shown}
			{open}
			where={listed ? 'listed' : 'comment'}
			{showNewer}
			onclosed={() => {
				article?.focus({ preventScroll: true });
			}}
		/>
	{:else}
		<p class="where">
			<strong>Your comment</strong>
			{#if listed}<span class="path"><PathText path={comment.anchor.path} /></span>{/if}
			<span>{lines}</span>
			{#if when !== ''}<span>{when}</span>{/if}
		</p>
		{#if listed && elsewhere !== undefined}<p class="elsewhere">{elsewhere}</p>{/if}
		<p class="words">{comment.body}</p>
		{#if notDeleted !== undefined}
			<p class="problem" role="alert">It was not deleted. {notDeleted.message}</p>
		{/if}
		{#if open || (listed && elsewhere === undefined && ongo !== undefined)}
			<p class="actions">
				{#if listed && elsewhere === undefined && ongo !== undefined}
					<button
						type="button"
						aria-label="Go to its lines: {shownPath(comment.anchor.path)}, {lines}"
						onclick={ongo}
					>
						Go to its lines
					</button>
				{/if}
				{#if open}
					<button
						type="button"
						aria-label="Edit your comment on {name}"
						onclick={() => {
							notDeleted = undefined;
							comments.edit(comment);
						}}
					>
						Edit
					</button>
					<button
						type="button"
						aria-label="Delete your comment on {name}"
						onclick={() => {
							asking = true;
						}}
					>
						Delete
					</button>
				{/if}
				{#if notDeleted?.behind === true}
					<button type="button" onclick={showNewer}>Show the new version</button>
				{/if}
			</p>
		{/if}
	{/if}
</article>
{#if asking}
	<!-- Among a file's lines the text is code's: the question is asked in the page's own. -->
	<div class="asking">
		<ConfirmDialog
			bind:open={asking}
			heading="Delete this comment?"
			confirm="Delete"
			onconfirm={remove}
		>
			Your comment on {name} will be deleted. Nothing brings it back.
		</ConfirmDialog>
	</div>
{/if}

<style>
	.comment {
		max-width: 46rem;
		margin: 0.5rem 0.75rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-accent);
		border-radius: 6px;
		background: var(--color-background);
		font-family: var(--font-body);
		font-size: 0.875rem;
		line-height: 1.5;
		scroll-margin-top: 4rem;
	}

	p {
		margin: 0;
	}

	.where {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.6rem;
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	.where strong {
		color: var(--color-text);
	}

	.comment.listed {
		margin-inline: 0;
	}

	.path {
		font-family: var(--font-code);
		overflow-wrap: anywhere;
	}

	.elsewhere {
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	.asking {
		font-family: var(--font-body);
		font-size: 1rem;
		line-height: 1.5;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.4rem;
	}

	.problem {
		margin-top: 0.3rem;
		color: var(--color-removed);
	}

	.actions button {
		padding: 0.1rem 0.6rem;
		font-size: 0.8125rem;
	}

	.words {
		margin-top: 0.2rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
