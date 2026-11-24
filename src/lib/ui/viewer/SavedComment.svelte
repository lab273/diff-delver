<!--
	One saved comment, as the reviewer reads it back: under its lines in the
	diff, or in the list of all comments. Its words are the reviewer's own and
	are drawn as plain text, line breaks kept: nothing in them is read as
	markup, so nothing in them can do anything.
-->
<script lang="ts">
	import type { DraftCommentView } from '#lib/api/schemas.ts';
	import { describeCommentLines } from '#lib/core/review/draft-comment.ts';
	import { describeOtherVersion } from '#lib/core/review/comment-places.ts';
	import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
	import { shownPath } from '#lib/core/shown-path.tiny.ts';
	import { describeTimeAgo } from '#lib/core/time-ago.ts';
	import PathText from '#lib/ui/PathText.svelte';
	import type { Timestamp } from '#lib/core/timestamp.tiny.ts';

	let {
		comment,
		now,
		shown,
		listed = false
	}: {
		comment: DraftCommentView;
		/** The daemon's time when the draft was read, to say how long ago; undefined, and it is not said. */
		now: Timestamp | undefined;
		/** The version the page shows. */
		shown: RevisionNumber;
		/** In the list of all comments, where it names its file and says when its lines are elsewhere. */
		listed?: boolean;
	} = $props();

	const elsewhere = $derived(describeOtherVersion(comment.version, shown));

	const lines = $derived(describeCommentLines(comment.anchor));
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
	class="comment"
	class:listed
	tabindex="-1"
	data-comment={listed ? undefined : comment.id}
	aria-label="Your comment on {listed ? `${shownPath(comment.anchor.path)}, ` : ''}{lines}"
>
	<p class="where">
		<strong>Your comment</strong>
		{#if listed}<span class="path"><PathText path={comment.anchor.path} /></span>{/if}
		<span>{lines}</span>
		{#if when !== ''}<span>{when}</span>{/if}
	</p>
	{#if listed && elsewhere !== undefined}<p class="elsewhere">{elsewhere}</p>{/if}
	<p class="words">{comment.body}</p>
</article>

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

	.words {
		margin-top: 0.2rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
