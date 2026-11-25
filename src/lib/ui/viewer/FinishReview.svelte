<!--
	Finishing a review (DESIGN 8.6): one press of "Finish and copy" finishes the
	draft's saved comments as the Delve's next review and puts it on the
	clipboard, as Markdown written for a language model, the same text an
	agent reads with `get_review`. What it will hand over can be read first, in
	place. Each finished review can be copied again, or read, afterwards.

	It asks the daemon for what finishing would hand over only when that is
	opened, and again when the draft changes while it is open; finishing sends
	the comments the page shows, so nothing written in another tab is handed
	over unseen.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { describeApiError } from '#lib/api/client.ts';
	import type { FinishedReviewView, ReviewPreviewView } from '#lib/api/schemas.ts';
	import { textToCopy } from '#lib/core/agent-setup/text-to-copy.tiny.ts';
	import type { ReportId } from '#lib/core/report-id.tiny.ts';
	import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
	import { describeTimeAgo } from '#lib/core/time-ago.ts';
	import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
	import { countOf } from '#lib/core/viewer/words.ts';
	import VisibleText from '#lib/ui/VisibleText.svelte';
	import { pageClient } from '#lib/ui/client.ts';
	import type { Comments } from './comments.svelte.ts';

	let {
		id,
		comments,
		version,
		open
	}: {
		id: ReportId;
		comments: Comments;
		/** The version the page shows. */
		version: RevisionNumber;
		/** Whether the Delve is open. */
		open: boolean;
	} = $props();

	let reviews = $state.raw<readonly FinishedReviewView[]>();
	let now = $state.raw<Timestamp>();
	let previewOpen = $state(false);
	let preview = $state.raw<ReviewPreviewView>();
	let previewProblem = $state('');
	let finishing = $state(false);
	let problem = $state('');
	let said = $state('');
	/** The finished review whose text is shown, by number. */
	let reading = $state<number>();
	const copyButtons: Record<number, HTMLButtonElement | undefined> = $state({});
	const previewId = $props.id();

	const saved = $derived(comments.saved ?? []);
	const next = $derived((reviews?.at(-1)?.number ?? 0) + 1);
	const unsaved = $derived(comments.writing.some((w) => w.worthKeeping));

	async function loadReviews(): Promise<void> {
		const read = await pageClient().reviews(id);
		if (!read.ok) {
			problem = describeApiError(read.error);
			return;
		}
		reviews = read.value.reviews;
		now = read.value.now;
	}

	$effect(() => {
		void loadReviews();
	});

	/** What finishing would hand over, read again whenever the draft changes while it is shown. */
	$effect(() => {
		if (!previewOpen || saved.length === 0) return;
		let current = true;
		void pageClient()
			.previewReview(id, version)
			.then((read) => {
				if (!current) return;
				if (read.ok) {
					preview = read.value;
					previewProblem = '';
				} else previewProblem = describeApiError(read.error);
			});
		return () => {
			current = false;
		};
	});

	async function copy(text: string): Promise<boolean> {
		try {
			await navigator.clipboard.writeText(textToCopy(text));
			return true;
		} catch {
			return false;
		}
	}

	async function finish(): Promise<void> {
		if (finishing) return;
		finishing = true;
		problem = '';
		said = '';
		const finished = await pageClient().finishReview(id, {
			version,
			comments: saved.map((c) => ({ id: c.id, edits: c.edits }))
		});
		finishing = false;
		if (!finished.ok) {
			problem = describeApiError(finished.error);
			void comments.load();
			return;
		}
		const review = finished.value;
		const copied = await copy(review.text);
		reviews = [...(reviews ?? []), review];
		now = review.submittedAt;
		previewOpen = false;
		preview = undefined;
		await comments.load();
		said = copied
			? `Review ${String(review.number)} is finished and copied. Paste it to your agent, or ask your agent to act on your review in diff delver.`
			: `Review ${String(review.number)} is finished, but this browser would not let diff delver copy it. Press “Copy review ${String(review.number)}” to try again, or show it and copy the text yourself.`;
		await tick();
		copyButtons[review.number]?.focus();
	}

	async function copyAgain(review: FinishedReviewView): Promise<void> {
		said = (await copy(review.text))
			? `Review ${String(review.number)} copied.`
			: `This browser would not let diff delver copy review ${String(review.number)}. Show it and copy the text yourself.`;
	}

	function linesOf(text: string): readonly string[] {
		return text.replace(/\n$/, '').split('\n');
	}
</script>

{#if saved.length > 0 || (reviews?.length ?? 0) > 0}
	<section class="finish" aria-label="Finish your review">
		{#if saved.length > 0}
			<p class="lead">
				Finishing makes your {countOf(saved.length, 'comment', 'comments')} review {next}. The
				review is copied, ready to paste to your agent, and your agent can also read it from diff
				delver. Your next comment starts review {next + 1}.
			</p>
			{#if unsaved}
				<p class="note">
					What you are writing in a comment box is not saved, so it is not in this review.
				</p>
			{/if}
			<div class="actions">
				{#if open}
					<button type="button" class="primary" disabled={finishing} onclick={finish}>
						{finishing ? 'Finishing…' : 'Finish and copy'}
					</button>
				{/if}
				<button
					type="button"
					aria-expanded={previewOpen}
					aria-controls={previewId}
					onclick={() => (previewOpen = !previewOpen)}
				>
					Show what will be copied
				</button>
			</div>
			<div id={previewId} hidden={!previewOpen}>
				{#if previewOpen}
					{#if previewProblem !== ''}
						<p role="alert">{previewProblem}</p>
					{:else if preview === undefined}
						<p role="status">Preparing what will be copied…</p>
					{:else}
						<div class="text" role="region" aria-label="What will be copied">
							<pre><code
									>{#each linesOf(preview.text) as line, i (i)}{i > 0 ? '\n' : ''}<VisibleText
											text={line}
										/>{/each}</code
								></pre>
						</div>
					{/if}
				{/if}
			</div>
		{:else}
			<p class="lead">Your draft has no comments. Your next comment starts review {next}.</p>
		{/if}
		{#if problem !== ''}
			<p class="problem" role="alert">{problem}</p>
		{/if}
		<p class="said" role="status">{said}</p>
		{#if reviews !== undefined && reviews.length > 0}
			<h3>Finished reviews</h3>
			<ul>
				{#each [...reviews].reverse() as review (review.number)}
					<li>
						<span>
							Review {review.number}: {countOf(review.comments, 'comment', 'comments')}, finished
							{now === undefined ? '' : describeTimeAgo(review.submittedAt, now)} on version {review.version}
						</span>
						<button
							type="button"
							bind:this={copyButtons[review.number]}
							onclick={() => copyAgain(review)}
						>
							Copy review {review.number}
						</button>
						<button
							type="button"
							aria-expanded={reading === review.number}
							onclick={() => (reading = reading === review.number ? undefined : review.number)}
						>
							Show review {review.number}
						</button>
						{#if reading === review.number}
							<div class="text" role="region" aria-label="Review {review.number} as it was copied">
								<pre><code
										>{#each linesOf(review.text) as line, i (i)}{i > 0 ? '\n' : ''}<VisibleText
												text={line}
											/>{/each}</code
									></pre>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}

<style>
	.finish {
		margin-block: 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		padding: 0.75rem;
		max-width: 60rem;
	}

	.lead,
	.note,
	.problem {
		margin: 0 0 0.5rem;
		max-width: 46rem;
	}

	.note {
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.primary {
		background: var(--color-primary-button);
		border-color: var(--color-primary-button);
		color: var(--color-on-primary-button);
	}

	.primary:hover {
		background: var(--color-primary-button-hover);
	}

	.text {
		margin: 0.5rem 0 0;
		max-height: 24rem;
		overflow: auto;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-subtle);
		padding: 0.5rem 0.75rem;
		font-family: var(--font-code);
		font-size: 0.8125rem;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.text pre {
		margin: 0;
		font: inherit;
		white-space: inherit;
	}

	.said {
		margin: 0.5rem 0 0;
	}

	.said:empty {
		margin: 0;
	}

	h3 {
		margin: 0.75rem 0 0.25rem;
		font-size: 0.875rem;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.6rem;
		margin-top: 0.4rem;
		font-size: 0.875rem;
	}

	li button {
		padding: 0.1rem 0.6rem;
		font-size: 0.8125rem;
	}

	li .text {
		flex-basis: 100%;
	}
</style>
