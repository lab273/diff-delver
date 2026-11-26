<!--
	Finishing a review (DESIGN 8.6): one press of "Finish and copy" finishes the
	draft's overall review and saved comments as the Delve's next review and puts it on the
	clipboard, as Markdown written for a language model, the same text an
	agent reads with `get_review`. What it will hand over can be read first, in
	place. Each finished review can be copied again, or read, afterwards.

	On a pull request's Delve, the main button finishes it, posts it to the
	pull request as one GitHub review and copies it: published as the kind
	chosen, Comment to start with, or, with the tick box, as a draft only the
	reviewer sees on GitHub until they submit it there. "Finish and copy
	only" hands it over without posting it. A finished review says where it
	was posted, with a link to it on GitHub.

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
	import { NO_EDITS } from '#lib/core/edit-count.tiny.ts';
	import type { ReportId } from '#lib/core/report-id.tiny.ts';
	import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
	import { describeTimeAgo } from '#lib/core/time-ago.ts';
	import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
	import { describeReviewContents, isWritten } from '#lib/core/review/overall-review.ts';
	import {
		describePostedAs,
		gitHubReviewKindName,
		GITHUB_REVIEW_KINDS,
		type GitHubReviewKind
	} from '#lib/core/github/github-review.ts';
	import { pullRequestShortName, type PullRequestRef } from '#lib/core/github/pull-request.ts';
	import VisibleText from '#lib/ui/VisibleText.svelte';
	import { pageClient } from '#lib/ui/client.ts';
	import type { Comments } from './comments.svelte.ts';

	let {
		id,
		pullRequest,
		comments,
		version,
		open
	}: {
		id: ReportId;
		/** The pull request the Delve follows, to post the review to; undefined for other Delves. */
		pullRequest: PullRequestRef | undefined;
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
	/** What the review is posted to GitHub as: Comment to start with. */
	let kind = $state<GitHubReviewKind>('comment');
	/** Whether it is posted as a draft on GitHub, its kind then set aside. */
	let asDraft = $state(false);

	const saved = $derived(comments.saved ?? []);
	const overall = $derived(comments.overall);
	const overallEdits = $derived(overall?.edits);
	const written = $derived(isWritten(overall?.body ?? ''));
	/** Something to finish: an overall review or a comment. */
	const drafted = $derived(saved.length > 0 || written);
	const contents = $derived(describeReviewContents(saved.length, written));
	const next = $derived((reviews?.at(-1)?.number ?? 0) + 1);
	const unsaved = $derived(comments.overallUnsaved || comments.writing.some((w) => w.worthKeeping));

	async function loadReviews(): Promise<void> {
		const read = await pageClient().reviews(id);
		if (!read.ok) {
			problem = describeApiError(read.error);
			return;
		}
		reviews = read.value.reviews;
		now = read.value.now;
	}

	// Read once, and again whenever the person comes back to the page, since
	// another tab may have finished a review meanwhile.
	$effect(() => {
		const read = (): void => {
			if (document.visibilityState === 'visible') void loadReviews();
		};
		read();
		window.addEventListener('focus', read);
		document.addEventListener('visibilitychange', read);
		return () => {
			window.removeEventListener('focus', read);
			document.removeEventListener('visibilitychange', read);
		};
	});

	/** What finishing would hand over, read again whenever the draft changes while it is shown. */
	$effect(() => {
		// Read again when the overall review changes too.
		if (!open || !previewOpen || !drafted || overallEdits === undefined) return;
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

	/**
	 * Copies text that is still to come, asking for the clipboard now, while the
	 * press that asked is fresh: a browser may refuse a copy made only once a
	 * round trip has ended. Where the clipboard cannot take text to come, it is
	 * copied when it comes. Nothing is copied when it does not come.
	 */
	async function copyWhenReady(text: Promise<string | undefined>): Promise<boolean> {
		if (typeof ClipboardItem === 'function' && typeof navigator.clipboard.write === 'function') {
			try {
				const blob = text.then((t) => {
					if (t === undefined) throw new Error('Nothing to copy');
					return new Blob([textToCopy(t)], { type: 'text/plain' });
				});
				await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
				return true;
			} catch {
				// Refused, or nothing came: copied the plain way below, if it came.
			}
		}
		const came = await text;
		return came === undefined ? false : copy(came);
	}

	/** Finishes the draft and copies it, and, with `post`, posts it to the pull request first. */
	async function finish(post: boolean): Promise<void> {
		if (finishing) return;
		finishing = true;
		problem = '';
		said = '';
		const overallShown = comments.overall?.edits ?? NO_EDITS;
		const request = pageClient().finishReview(id, {
			version,
			comments: saved.map((c) => ({ id: c.id, edits: c.edits })),
			overall: overallShown,
			...(post && pullRequest !== undefined ? { github: { kind, draft: asDraft } } : {})
		});
		const copying = copyWhenReady(request.then((r) => (r.ok ? r.value.text : undefined)));
		const finished = await request;
		finishing = false;
		if (!finished.ok) {
			// Whatever went wrong, show the draft and the reviews as they are now.
			await Promise.all([comments.load(), loadReviews()]);
			problem = describeApiError(finished.error);
			return;
		}
		const review = finished.value;
		const copied = await copying;
		reviews = [...(reviews ?? []), review];
		now = review.submittedAt;
		previewOpen = false;
		preview = undefined;
		await comments.reviewFinished(overallShown);
		said = `${finishedWords(review, copied)}${inTextWords(review)}`;
		await tick();
		copyButtons[review.number]?.focus();
	}

	/** What finishing did, in words: finished, posted and copied. */
	function finishedWords(review: FinishedReviewView, copied: boolean): string {
		const n = String(review.number);
		const posted = review.posted;
		if (posted === null) {
			return copied
				? `Review ${n} is finished and copied. Paste it to your agent, or ask your agent to act on your review in diff delver.`
				: `Review ${n} is finished, but this browser would not let diff delver copy it. Press “Copy review ${n}” to try again, or show it and copy the text yourself.`;
		}
		const where =
			posted.as === 'draft'
				? `posted to GitHub as a draft, which only you can see there until you submit it`
				: `posted to GitHub ${describePostedAs(posted.as)}`;
		return copied
			? `Review ${n} is finished, ${where}, and copied.`
			: `Review ${n} is finished and ${where}, but this browser would not let diff delver copy it. Press “Copy review ${n}” to try again.`;
	}

	/** What went in the review's text on GitHub, when anything did. */
	function inTextWords(review: FinishedReviewView): string {
		const count = review.posted?.inText ?? 0;
		if (count === 0) return '';
		return count === 1
			? ' 1 comment is on lines GitHub does not show, so it is in the review’s text on GitHub.'
			: ` ${String(count)} comments are on lines GitHub does not show, so they are in the review’s text on GitHub.`;
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

{#if drafted || (reviews?.length ?? 0) > 0}
	<section class="finish" id="finish-review" tabindex="-1" aria-label="Finish your review">
		<p class="said" role="status">{said}</p>
		{#if drafted && !open}
			<p class="lead">
				This Delve is closed, so {contents} cannot be finished. Reopen it to finish
				{saved.length === 1 || (saved.length === 0 && written) ? 'it' : 'them'} as review {next}.
			</p>
		{:else if drafted && pullRequest !== undefined}
			<p class="lead">
				Finishing makes {contents} review {next}. It is posted to {pullRequestShortName(
					pullRequest
				)} on GitHub as one review from your GitHub account, and copied, ready to paste to your agent.
				Your next comment or overall review starts review {next + 1}.
			</p>
			{#if unsaved}
				<p class="note">
					What you are writing and have not saved, in a comment box or the overall review, is not in
					this review.
				</p>
			{/if}
			<fieldset class="kind" disabled={finishing || asDraft}>
				<legend>Post to GitHub as</legend>
				{#each GITHUB_REVIEW_KINDS as each (each)}
					<label>
						<input type="radio" name="{previewId}-kind" value={each} bind:group={kind} />
						{gitHubReviewKindName(each)}
					</label>
				{/each}
			</fieldset>
			<label class="draft">
				<input type="checkbox" bind:checked={asDraft} disabled={finishing} />
				Post as a draft on GitHub
			</label>
			{#if asDraft}
				<p class="note">
					As a draft, only you can see the review on GitHub until you submit it there. GitHub asks
					then whether it is a comment, an approval or a request for changes, so that is not chosen
					here.
				</p>
			{/if}
			<div class="actions">
				<button
					type="button"
					class="primary"
					id="finish-and-copy"
					disabled={finishing}
					onclick={() => finish(true)}
				>
					{finishing ? 'Finishing…' : 'Finish and post to GitHub'}
				</button>
				<button type="button" disabled={finishing} onclick={() => finish(false)}>
					Finish and copy only
				</button>
				<button
					type="button"
					aria-expanded={previewOpen}
					aria-controls={previewId}
					onclick={() => (previewOpen = !previewOpen)}
				>
					Show what will be copied
				</button>
			</div>
		{:else if drafted}
			<p class="lead">
				Finishing makes {contents} review {next}. The review is copied, ready to paste to your
				agent, and your agent can also read it from diff delver. Your next comment or overall review
				starts review {next + 1}.
			</p>
			{#if unsaved}
				<p class="note">
					What you are writing and have not saved, in a comment box or the overall review, is not in
					this review.
				</p>
			{/if}
			<div class="actions">
				<button
					type="button"
					class="primary"
					id="finish-and-copy"
					disabled={finishing}
					onclick={() => finish(false)}
				>
					{finishing ? 'Finishing…' : 'Finish and copy'}
				</button>
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
			<p class="lead">
				Your draft has no comments and no overall review. Your next comment or overall review starts
				review {next}.
			</p>
		{/if}
		{#if problem !== ''}
			<p class="problem" role="alert">{problem}</p>
		{/if}
		{#if reviews !== undefined && reviews.length > 0}
			<h3>Finished reviews</h3>
			<ul>
				{#each [...reviews].reverse() as review (review.number)}
					<li>
						<span>
							Review {review.number}: {describeReviewContents(
								review.comments,
								review.overall,
								'listed'
							)}, finished
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
						{#if review.posted !== null}
							<span class="posted">
								{review.posted.as === 'draft'
									? 'Posted as a draft on GitHub: submit it there.'
									: `Posted to GitHub ${describePostedAs(review.posted.as)}.`}
							</span>
							<a href={review.posted.address} target="_blank" rel="external noopener noreferrer">
								{review.posted.as === 'draft'
									? `Submit review ${String(review.number)} on GitHub`
									: `Open review ${String(review.number)} on GitHub`}
							</a>
						{/if}
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

	.kind {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		margin: 0 0 0.5rem;
		border: none;
		padding: 0;
	}

	.kind legend {
		padding: 0;
		margin-bottom: 0.25rem;
		font-weight: 700;
		font-size: 0.875rem;
	}

	.kind:disabled label {
		color: var(--color-muted);
	}

	.kind label,
	.draft {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}

	.draft {
		margin: 0 0 0.5rem;
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
		margin: 0 0 0.5rem;
		max-width: 46rem;
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
