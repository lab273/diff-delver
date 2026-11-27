<!--
	The threads of earlier reviews on the version shown (DESIGN 6.3), listed
	above the diff with how many are open and how many had their code changed
	since: each open one with its file, its lines and its first words, and the
	way to go to it among the lines, where it is replied to or resolved; `p`
	goes to the next. One not drawn among the lines, because its lines are
	gone, its file is not in this version's diff (as when the agent put it back
	as it was), or it was resolved in an earlier review, is drawn here in full,
	to reply to, resolve or reopen, and `p` comes here for it. Drawn only when the Delve has threads on this
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
	import type { ReviewNumber } from '#lib/core/review-number.tiny.ts';
	import { shownPath } from '#lib/core/shown-path.tiny.ts';
	import PathText from '#lib/ui/PathText.svelte';
	import EarlierThread from './EarlierThread.svelte';
	import type { Comments } from './comments.svelte.ts';

	let {
		threads,
		drawn,
		comments,
		shown,
		act,
		asOf,
		ongo,
		showNewer
	}: {
		threads: readonly EarlierThreadView[];
		/** The paths of the files the version shown draws, among whose lines threads are drawn. */
		drawn: ReadonlySet<string>;
		comments: Comments;
		shown: RevisionNumber;
		/** Whether they can be replied to or resolved here. */
		act: boolean;
		/** The finished review the page shows the Delve as of, whose own comments are among these. */
		asOf?: ReviewNumber | undefined;
		/** Goes to a thread among the lines of the version shown. */
		ongo: (thread: EarlierThreadView) => void;
		showNewer: () => void;
	} = $props();

	const heading = $derived(
		asOf === undefined
			? describeEarlierThreads(threads)
			: describeEarlierThreads(threads).replace(
					/^From earlier reviews/,
					`Comments up to review ${String(asOf)}`
				)
	);
	/** Whether a thread is drawn among the lines: open, with lines in a file the version shows. */
	const atLines = (t: EarlierThreadView): boolean =>
		t.at !== null && t.status !== 'resolved' && drawn.has(t.at.path);
	/** Drawn among the lines, so listed in short here. */
	const short = $derived(threads.filter(atLines));
	/**
	 * Not drawn among the lines, so drawn here in full: one whose lines are
	 * gone, whose file is not in this version's diff, or resolved earlier.
	 */
	const here = $derived(threads.filter((t) => !atLines(t)));

	/** The first line of a thread's first words, cut short. */
	function teaser(thread: EarlierThreadView): string {
		const words = (thread.messages[0]?.body ?? '').trim().split('\n')[0] ?? '';
		return words.length > 80 ? `${words.slice(0, 79)}…` : words;
	}
</script>

<section class="earlier" aria-labelledby="earlier-threads-heading">
	<h2 id="earlier-threads-heading">{heading}</h2>
	<p class="muted">
		{asOf === undefined
			? 'What you said in earlier reviews, at its lines in this version.'
			: `What you had said by the end of review ${String(asOf)}, at its lines in this version, as it stood then.`}{act
			? ' A reply, and what you resolve, go in this review.'
			: ''}
		<kbd aria-hidden="true">p</kbd> goes to the next one open.
	</p>
	{#if short.length > 0}
		<ul>
			{#each short as thread (thread.id)}
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
