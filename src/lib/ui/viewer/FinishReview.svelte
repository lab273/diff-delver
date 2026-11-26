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
	only" hands it over without posting it. Before posting, it says how many
	comments go in the review's text, since GitHub shows no lines for them,
	and "Show what will be posted" shows the review's text as GitHub will
	have it, and which comments go on their lines and which in the text. A
	finished review says where it was posted, with a link to it on GitHub.

	It asks the daemon for what finishing would hand over only when that is
	opened, or on a pull request's Delve, to say what goes in the text, and
	again when the draft changes; finishing sends
	the comments the page shows, so nothing written in another tab is handed
	over unseen.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { describeApiError } from '#lib/api/client.ts';
	import type {
		FinishedReviewView,
		JustFinishedView,
		ReviewPreviewView
	} from '#lib/api/schemas.ts';
	import { textToCopy } from '#lib/core/agent-setup/text-to-copy.tiny.ts';
	import { NO_EDITS } from '#lib/core/edit-count.tiny.ts';
	import type { ReportId } from '#lib/core/report-id.tiny.ts';
	import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
	import { describeTimeAgo } from '#lib/core/time-ago.ts';
	import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
	import { describeReviewContents, isWritten } from '#lib/core/review/overall-review.ts';
	import { describeCommentLines } from '#lib/core/review/draft-comment.ts';
	import PathText from '#lib/ui/PathText.svelte';
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
	/** Which finish is under way: posting to GitHub, copying only, or copying only anyway. */
	let pressed = $state<'post' | 'copy' | 'anyway'>();
	/**
	 * The review whose earlier post GitHub could not be asked about, when
	 * finishing and copying it only was refused so: it may then be finished
	 * and copied anyway.
	 */
	let unchecked = $state<number>();
	const finishing = $derived(pressed !== undefined);
	/** Whether what will be posted to GitHub is shown. */
	let postedOpen = $state(false);
	let problem = $state('');
	let said = $state('');
	/** The finished review whose text is shown, by number. */
	let reading = $state<number>();
	const copyButtons: Record<number, HTMLButtonElement | undefined> = $state({});
	const previewId = $props.id();
	const postedId = `${previewId}-posted`;
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
	const contents = $derived(
		describeReviewContents({
			comments: comments.commentCount,
			flags: comments.flagCount,
			overall: written
		})
	);
	const next = $derived((reviews?.at(-1)?.number ?? 0) + 1);
	const unsaved = $derived(comments.overallUnsaved || comments.writing.some((w) => w.worthKeeping));
	/** The draft's comments and their words, so what finishing would hand over is read again when they change. */
	const draftKey = $derived(saved.map((c) => `${String(c.id)}:${String(c.edits)}`).join(','));
	/** What finishing would hand over is wanted: shown, or on a pull request's Delve, to count what goes in the text. */
	const wanted = $derived(previewOpen || postedOpen || pullRequest !== undefined);
	/** The comments that go on their lines on GitHub, and those in the review's text, as last read. */
	const onLines = $derived(new Set(preview?.github?.onLines ?? []));
	const previewed = $derived(
		(preview?.comments ?? []).flatMap((shown) => saved.filter((c) => c.id === shown.id))
	);
	const inText = $derived(previewed.filter((c) => c.kind === 'comment' && !onLines.has(c.id)));
	/** Flags go in the review's text on GitHub, never on lines. */
	const flagsInText = $derived(previewed.filter((c) => c.kind === 'flag'));
	const lineComments = $derived(previewed.filter((c) => onLines.has(c.id)));

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
		// Read again when the overall review or a comment changes too.
		const key = draftKey;
		if (!open || !wanted || !drafted || overallEdits === undefined) return;
		let current = true;
		void pageClient()
			.previewReview(id, version)
			.then((read) => {
				if (!current || key !== draftKey) return;
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

	/**
	 * Finishes the draft and copies it, and, with `post`, posts it to the pull
	 * request first; with `anyway`, without looking on GitHub for an earlier
	 * post of it.
	 */
	async function finish(post: boolean, anyway = false): Promise<void> {
		if (finishing) return;
		pressed = post ? 'post' : anyway ? 'anyway' : 'copy';
		problem = '';
		said = '';
		unchecked = undefined;
		const overallShown = comments.overall?.edits ?? NO_EDITS;
		const request = pageClient().finishReview(id, {
			version,
			comments: saved.map((c) => ({ id: c.id, edits: c.edits })),
			overall: overallShown,
			...(post && pullRequest !== undefined ? { github: { kind, draft: asDraft } } : {}),
			...(anyway ? { forgetEarlierPost: true as const } : {})
		});
		const copying = copyWhenReady(request.then((r) => (r.ok ? r.value.text : undefined)));
		const finished = await request;
		pressed = undefined;
		if (!finished.ok) {
			// Whatever went wrong, show the draft and the reviews as they are now.
			await Promise.all([comments.load(), loadReviews()]);
			problem = describeApiError(finished.error);
			const { error } = finished;
			if (error.kind === 'refused' && error.reason === 'EarlierPostUnchecked') unchecked = next;
			return;
		}
		const review = finished.value;
		const copied = await copying;
		reviews = [...(reviews ?? []), review];
		now = review.submittedAt;
		previewOpen = false;
		postedOpen = false;
		preview = undefined;
		await comments.reviewFinished(overallShown);
		said = `${finishedWords(review, copied)}${postedInTextWords(review)}`;
		await tick();
		copyButtons[review.number]?.focus();
	}

	/** What finishing did, in words: finished, posted and copied. */
	function finishedWords(review: JustFinishedView, copied: boolean): string {
		const n = String(review.number);
		const posted = review.posted;
		if (review.earlier !== null) {
			const kept = review.earlier.draftKept
				? ` What you added or changed since is still in your draft, for review ${String(review.number + 1)}.`
				: '';
			return `Your earlier post of review ${n} had reached GitHub, so it was not posted again: review ${n} is finished as it was posted then${copied ? ', and copied' : ''}.${kept}`;
		}
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
	function postedInTextWords(review: FinishedReviewView): string {
		const count = review.posted?.inText ?? 0;
		if (count === 0) return '';
		return count === 1
			? ' 1 comment is on lines GitHub does not show, so it is in the review’s text on GitHub.'
			: ` ${String(count)} comments are on lines GitHub does not show, so they are in the review’s text on GitHub.`;
	}

	/** Before posting: how many comments will go in the review's text, when any will. */
	function inTextWords(count: number, total: number): string {
		if (count === 0) return '';
		if (total === 1) {
			return 'Your comment is on lines GitHub does not show, so it goes in the review’s text.';
		}
		return count === 1
			? `1 of your ${String(total)} comments is on lines GitHub does not show, so it goes in the review’s text.`
			: `${String(count)} of your ${String(total)} comments are on lines GitHub does not show, so they go in the review’s text.`;
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
			<p
				class="note in-text"
				aria-busy={preview === undefined && previewProblem === '' ? 'true' : undefined}
			>
				{inTextWords(inText.length, previewed.length - flagsInText.length)}
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
					{pressed === 'post' ? 'Posting…' : 'Finish and post to GitHub'}
				</button>
				<button type="button" disabled={finishing} onclick={() => finish(false)}>
					{pressed === 'copy' ? 'Finishing…' : 'Finish and copy only'}
				</button>
				<button
					type="button"
					aria-expanded={postedOpen}
					aria-controls={postedId}
					onclick={() => (postedOpen = !postedOpen)}
				>
					Show what will be posted
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
			<div id={postedId} hidden={!postedOpen}>
				{#if postedOpen}
					{#if previewProblem !== ''}
						<p role="alert">{previewProblem}</p>
					{:else if preview?.github == null}
						<p role="status">Preparing what will be posted…</p>
					{:else}
						<div class="text" role="region" aria-label="What will be posted to GitHub">
							<pre><code
									>{#each linesOf(preview.github.body) as line, i (i)}{i > 0
											? '\n'
											: ''}<VisibleText text={line} />{/each}</code
								></pre>
						</div>
						<p class="note">
							This is the review’s text as posted, written in Markdown, which GitHub shows
							formatted. It ends with a mark GitHub does not show, made when it is posted, so diff
							delver can find it there again.
						</p>
						{#if lineComments.length > 0}
							<h4>On their lines on GitHub</h4>
							<ul class="placed">
								{#each lineComments as c (c.id)}
									<li><PathText path={c.anchor.path} />, {describeCommentLines(c.anchor)}</li>
								{/each}
							</ul>
						{/if}
						{#if inText.length > 0}
							<h4>In the review’s text, since GitHub does not show their lines</h4>
							<ul class="placed">
								{#each inText as c (c.id)}
									<li><PathText path={c.anchor.path} />, {describeCommentLines(c.anchor)}</li>
								{/each}
							</ul>
						{/if}
						{#if flagsInText.length > 0}
							<h4>Flagged for another look, in the review’s text</h4>
							<ul class="placed">
								{#each flagsInText as c (c.id)}
									<li><PathText path={c.anchor.path} />, {describeCommentLines(c.anchor)}</li>
								{/each}
							</ul>
						{/if}
					{/if}
				{/if}
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
		{#if unchecked !== undefined && unchecked === next && drafted && open}
			<div class="actions">
				<button type="button" disabled={finishing} onclick={() => finish(false, true)}>
					{pressed === 'anyway'
						? 'Finishing…'
						: `Finish and copy anyway — review ${String(next)} may already be on GitHub`}
				</button>
			</div>
		{/if}
		{#if reviews !== undefined && reviews.length > 0}
			<h3>Finished reviews</h3>
			<ul>
				{#each [...reviews].reverse() as review (review.number)}
					<li>
						<span>
							Review {review.number}: {describeReviewContents(review, 'listed')}, finished
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
							<p class="posted">
								{review.posted.as === 'draft'
									? 'Posted as a draft —'
									: `Posted to GitHub ${describePostedAs(review.posted.as)} —`}
								<a href={review.posted.address} target="_blank" rel="external noopener noreferrer">
									open review {review.number} on GitHub
								</a>{review.posted.as === 'draft' ? ' to submit it' : ''}
							</p>
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

	li .text,
	li .posted {
		flex-basis: 100%;
	}

	.posted {
		margin: 0;
	}

	.in-text:empty {
		display: none;
	}

	h4 {
		margin: 0.5rem 0 0.25rem;
		font-size: 0.875rem;
	}

	.placed {
		list-style: disc;
		padding-left: 1.25rem;
		font-size: 0.875rem;
	}

	.placed li {
		display: list-item;
		margin-top: 0.2rem;
	}
</style>
