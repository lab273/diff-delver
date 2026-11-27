<!--
	The threads of earlier reviews on the version shown (DESIGN 6.3), listed
	above the diff with how many are open and how many had their code changed
	since: each open one with its file, its lines and its first words, and the
	way to go to it among the lines, where it is replied to or resolved; `p`
	goes to the next. One whose lines are gone, and one resolved in an earlier
	review, which is not drawn among the lines, is drawn here in full, to reply
	to, resolve or reopen. Drawn only when the Delve has threads on this
	version.
-->
<script lang="ts">
	import type { EarlierThreadView } from '#lib/api/schemas.ts';
	import { describeCommentLines } from '#lib/core/review/draft-comment.ts';
	import {
		describeEarlierThreads,
		describeThreadStart,
		threadStatusWords
	} from '#lib/core/review/threads.ts';
	import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
	import { shownPath } from '#lib/core/shown-path.tiny.ts';
	import PathText from '#lib/ui/PathText.svelte';
	import EarlierThread from './EarlierThread.svelte';
	import type { Comments } from './comments.svelte.ts';

	let {
		threads,
		comments,
		shown,
		act,
		ongo,
		showNewer
	}: {
		threads: readonly EarlierThreadView[];
		comments: Comments;
		shown: RevisionNumber;
		/** Whether they can be replied to or resolved here. */
		act: boolean;
		/** Goes to a thread among the lines of the version shown. */
		ongo: (thread: EarlierThreadView) => void;
		showNewer: () => void;
	} = $props();

	const heading = $derived(describeEarlierThreads(threads));
	/** Drawn among the lines, so listed in short here. */
	const atLines = $derived(threads.filter((t) => t.at !== null && t.status !== 'resolved'));
	/** Not drawn among the lines: drawn here in full. */
	const here = $derived(threads.filter((t) => t.at === null || t.status === 'resolved'));

	/** The first line of a thread's first words, cut short. */
	function teaser(thread: EarlierThreadView): string {
		const words = (thread.messages[0]?.body ?? '').trim().split('\n')[0] ?? '';
		return words.length > 80 ? `${words.slice(0, 79)}…` : words;
	}
</script>

<section class="earlier" aria-labelledby="earlier-threads-heading">
	<h2 id="earlier-threads-heading">{heading}</h2>
	<p class="muted">
		What you said in earlier reviews, at its lines in this version. A reply, and what you resolve,
		go in this review. <kbd aria-hidden="true">p</kbd> goes to the next one open.
	</p>
	{#if atLines.length > 0}
		<ul>
			{#each atLines as thread (thread.id)}
				{@const resolution = comments.resolutionOf(thread.id)}
				<li>
					<span class="status" class:changed={thread.status === 'changed'}>
						{resolution === true ? 'Resolved in this review' : threadStatusWords(thread.status)}
					</span>
					<span>{describeThreadStart(thread)}</span>
					{#if thread.at !== null}
						<span class="path"><PathText path={thread.at.path} /></span>
						<span>{describeCommentLines(thread.at)}</span>
					{/if}
					<button
						type="button"
						aria-label="Go to the {describeThreadStart(thread).toLowerCase()} on {thread.at === null
							? ''
							: `${shownPath(thread.at.path)}, ${describeCommentLines(thread.at)}`}"
						onclick={() => {
							ongo(thread);
						}}
					>
						Go to its lines
					</button>
					{#if teaser(thread) !== ''}<span class="teaser">“{teaser(thread)}”</span>{/if}
				</li>
			{/each}
		</ul>
	{/if}
	{#each here as thread (thread.id)}
		<EarlierThread {thread} {comments} {shown} {act} listed {showNewer} />
	{/each}
</section>

<style>
	.earlier {
		margin-block: 0.75rem;
		font-size: 0.875rem;
	}

	h2 {
		margin: 0;
		font-size: 1rem;
	}

	p {
		margin: 0.2rem 0 0;
		max-width: 46rem;
	}

	.muted {
		color: var(--color-muted);
	}

	ul {
		margin: 0.4rem 0 0;
		padding: 0;
		list-style: none;
	}

	li {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.2rem 0.6rem;
		max-width: 46rem;
		padding: 0.2rem 0;
	}

	.status {
		padding: 0 0.4rem;
		border: 1px solid var(--color-border);
		border-radius: 999px;
	}

	.status.changed {
		border-color: var(--color-attention-border);
		background: var(--color-attention-background);
	}

	.path {
		font-family: var(--font-code);
		overflow-wrap: anywhere;
	}

	.teaser {
		flex-basis: 100%;
		color: var(--color-muted);
	}

	li button {
		padding: 0.1rem 0.6rem;
		font-size: 0.8125rem;
	}

	kbd {
		border: 1px solid var(--color-border);
		border-bottom-width: 2px;
		border-radius: 4px;
		padding: 0 0.3rem;
		font-size: 0.75rem;
		background: var(--color-subtle);
	}
</style>
