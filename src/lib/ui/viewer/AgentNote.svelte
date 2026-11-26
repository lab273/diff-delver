<!--
	One agent note (DESIGN 5), drawn under the last of its lines: marked as the
	agent's, with its label, its lines and the agent's words, rendered through
	the sanitiser as all agent text is. It is drawn quieter than the reviewer's
	own comments and flags, since it comes after their reading.

	While the Delve is open, a browser that may write the draft can dismiss it
	with one press (the list above the diff brings dismissed notes back), or
	promote it into the review: a comment of the reviewer's own on the same
	lines, quoting the agent's words, which they can then edit. On a closed
	Delve it is only read.
-->
<script lang="ts">
	import type { AgentNoteView } from '#lib/api/schemas.ts';
	import { noteLabelWords } from '#lib/core/review/agent-note.ts';
	import { describeCommentLines } from '#lib/core/review/draft-comment.ts';
	import AgentMarkdown from './AgentMarkdown.svelte';

	let {
		note,
		act,
		ondismiss,
		onpromote
	}: {
		note: AgentNoteView;
		/** Whether it can be dismissed or promoted here: the Delve is open, and this browser may write the draft. */
		act: boolean;
		/** Dismisses it; what went wrong, in words, or undefined. */
		ondismiss: () => Promise<string | undefined>;
		/** Promotes it into the draft; what went wrong, in words, or undefined. */
		onpromote: () => Promise<string | undefined>;
	} = $props();

	const lines = $derived(describeCommentLines(note.anchor));
	const label = $derived(noteLabelWords(note.label));
	let busy = $state(false);
	let problem = $state('');

	async function run(action: () => Promise<string | undefined>): Promise<void> {
		if (busy) return;
		busy = true;
		problem = (await action()) ?? '';
		busy = false;
	}
</script>

<article
	class="note"
	tabindex="-1"
	data-agent-note={note.id}
	aria-label="Agent note on {lines}: {label}"
>
	<p class="where">
		<strong>Agent note</strong>
		<span class="label">{label}</span>
		<span>{lines}</span>
	</p>
	<AgentMarkdown markdown={note.text} />
	{#if problem !== ''}<p class="problem" role="alert">{problem}</p>{/if}
	{#if act}
		<p class="actions">
			<button
				type="button"
				disabled={busy}
				aria-label="Promote the agent note on {lines}, {note.label}, to your review"
				onclick={() => run(onpromote)}
			>
				Promote to review
			</button>
			<button
				type="button"
				disabled={busy}
				aria-label="Dismiss the agent note on {lines}, {note.label}"
				onclick={() => run(ondismiss)}
			>
				Dismiss
			</button>
		</p>
	{/if}
</article>

<style>
	.note {
		max-width: 46rem;
		margin: 0.5rem 0.75rem;
		padding: 0.4rem 0.75rem;
		border: 1px dashed var(--color-border);
		border-radius: 6px;
		background: var(--color-subtle);
		color: var(--color-muted);
		font-family: var(--font-body);
		font-size: 0.8125rem;
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
	}

	.where strong {
		color: var(--color-text);
	}

	.label {
		padding: 0 0.4rem;
		border: 1px solid var(--color-border);
		border-radius: 999px;
	}

	.note :global(.agent-prose) {
		margin-block: 0.2rem 0;
		color: var(--color-text);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.4rem;
	}

	.actions button {
		padding: 0.1rem 0.6rem;
		font-size: 0.8125rem;
	}

	.problem {
		margin-top: 0.3rem;
		color: var(--color-removed);
	}
</style>
