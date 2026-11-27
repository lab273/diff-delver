<!--
	One finished review, read-only (DESIGN 6.4): when it was finished and on
	which version, how it was handed over, each thing it held against the
	version it was written on with where its thread stands today, and the text
	exactly as it was handed over, to copy again. Links lead to the Delve as it
	stood then, to the history and to the reviews before and after.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { describeApiError } from '#lib/api/client.ts';
	import { textToCopy } from '#lib/core/agent-setup/text-to-copy.tiny.ts';
	import { describePostedAs } from '#lib/core/github/github-review.ts';
	import { describeExactTime } from '#lib/core/history/history-words.ts';
	import { describeUnitProgress } from '#lib/core/reports/describe-report.ts';
	import { describeCommentLines } from '#lib/core/review/draft-comment.ts';
	import { threadStatusWords } from '#lib/core/review/threads.ts';
	import { describeTimeAgo } from '#lib/core/time-ago.ts';
	import PathText from '#lib/ui/PathText.svelte';
	import ReviewAccess from '#lib/ui/ReviewAccess.svelte';
	import VisibleText from '#lib/ui/VisibleText.svelte';
	import { pageClient } from '#lib/ui/client.ts';
	import CommentWords from '#lib/ui/viewer/CommentWords.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let said = $state('');

	function linesOf(text: string): readonly string[] {
		return text.replace(/\n$/, '').split('\n');
	}

	async function copyAgain(text: string): Promise<void> {
		const n = String(data.number);
		try {
			await navigator.clipboard.writeText(textToCopy(text));
		} catch {
			said = `This browser would not let diff delver copy review ${n}. Select the text below and copy it yourself.`;
			return;
		}
		void pageClient().noteCopied(data.id, data.number);
		said = `Review ${n} copied. Paste it to your agent, or ask your agent to act on your review in diff delver.`;
	}
</script>

<svelte:head>
	<title>Review {data.number} – diff delver</title>
</svelte:head>

{#if !data.review.ok}
	<h1 tabindex="-1">Review {data.number}</h1>
	{#if !data.canReview}
		<ReviewAccess diff={data.id} what="comments" />
	{:else}
		<p>{describeApiError(data.review.error)}</p>
	{/if}
	<p><a href={resolve('/diffs/[id]/history', { id: data.id })}>History of this Delve</a></p>
{:else}
	{@const past = data.review.value}
	{@const review = past.review}
	{@const n = String(review.number)}
	<h1 tabindex="-1">Review {n} of {past.title}</h1>
	<p class="when">
		Finished {describeTimeAgo(review.submittedAt, past.now)} on version {review.version}
		<span class="exact">({describeExactTime(review.submittedAt)})</span>.
		{review.version === past.current
			? 'That is still the current version.'
			: `The Delve is at version ${String(past.current)} now.`}
	</p>
	<p>
		Held {past.held}. {describeUnitProgress(review.progress)} then.
	</p>
	<nav class="links" aria-label="Review {n}">
		<a href="{resolve('/diffs/[id]', { id: data.id })}?review={n}">
			See the Delve as of review {n}
		</a>
		<a href={resolve('/diffs/[id]/history', { id: data.id })}>History of this Delve</a>
		<a href={resolve('/diffs/[id]', { id: data.id })}>Back to the current version</a>
		{#if review.number > 1}
			<a
				href={resolve('/diffs/[id]/reviews/[review]', {
					id: data.id,
					review: String(review.number - 1)
				})}
			>
				Review {review.number - 1}
			</a>
		{/if}
		{#if review.number < past.latest}
			<a
				href={resolve('/diffs/[id]/reviews/[review]', {
					id: data.id,
					review: String(review.number + 1)
				})}
			>
				Review {review.number + 1}
			</a>
		{/if}
	</nav>

	<section aria-labelledby="handed-over">
		<h2 id="handed-over">How it was handed over</h2>
		{#if past.deliveries.length === 0}
			<p>Nothing was noted of how it was handed over.</p>
		{:else}
			<ul>
				{#each past.deliveries as delivery (delivery)}
					<li>{delivery}</li>
				{/each}
			</ul>
		{/if}
		{#if review.posted !== null}
			<p>
				<a href={review.posted.address} target="_blank" rel="external noopener noreferrer">
					Open review {n} on GitHub
				</a>{review.posted.as === 'draft'
					? ', a draft only you can see there until you submit it.'
					: `, posted ${describePostedAs(review.posted.as)}.`}
			</p>
		{/if}
		<p class="said" role="status">{said}</p>
		<button type="button" onclick={() => copyAgain(review.text)}>Copy review {n} again</button>
	</section>

	<section aria-labelledby="what-it-held">
		<h2 id="what-it-held">What it held</h2>
		{#if past.items.length === 0 && past.resolutions.length === 0}
			<p>
				No comments or flags{review.overall ? ': only the overall review, in the text below' : ''}.
			</p>
		{:else}
			<p class="note">
				Each on the version it was written on, with where it stands today, on version {past.current}.
			</p>
			<ul class="items" aria-label="What review {n} held">
				{#each past.items as item, i (i)}
					<li>
						<p class="item-head">
							<strong>{item.kind}</strong>
							<span><PathText path={item.anchor.path} />, {describeCommentLines(item.anchor)}</span>
							<span class="version">on version {item.version}</span>
							<span class="status {item.status}">Today: {threadStatusWords(item.status)}</span>
						</p>
						{#if item.body !== ''}<CommentWords words={item.body} />{/if}
					</li>
				{/each}
				{#each past.resolutions as resolution, i (i)}
					<li>
						<p class="item-head">
							<strong>
								{resolution.resolved ? 'Resolved' : 'Opened again'}
								{resolution.from === null
									? 'a comment'
									: `a comment from review ${String(resolution.from)}`}
							</strong>
							{#if resolution.anchor !== null}
								<span>
									<PathText path={resolution.anchor.path} />, {describeCommentLines(
										resolution.anchor
									)}
								</span>
							{/if}
							<span class="status {resolution.status}">
								Today: {threadStatusWords(resolution.status)}
							</span>
						</p>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section aria-labelledby="the-text">
		<h2 id="the-text">The text handed over</h2>
		<div class="text" role="region" aria-label="Review {n} as it was handed over">
			<pre><code
					>{#each linesOf(review.text) as line, i (i)}{i > 0 ? '\n' : ''}<VisibleText
							text={line}
						/>{/each}</code
				></pre>
		</div>
	</section>
{/if}

<style>
	h1 {
		margin: 0 0 0.5rem;
		font-size: 1.75rem;
	}

	h2 {
		font-size: 1.125rem;
		margin: 1.5rem 0 0.5rem;
	}

	p {
		margin: 0.25rem 0;
		max-width: 46rem;
	}

	.when,
	.exact,
	.note,
	.version {
		color: var(--color-muted);
	}

	.exact,
	.note,
	.version {
		font-size: 0.875rem;
	}

	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		margin: 0.5rem 0;
	}

	.items {
		list-style: none;
		padding: 0;
		margin: 0;
		max-width: 60rem;
	}

	.items > li {
		border: 1px solid var(--color-border);
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		margin: 0 0 0.5rem;
	}

	.item-head {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		align-items: baseline;
	}

	.status {
		font-size: 0.875rem;
		font-weight: 700;
	}

	.text {
		max-width: 60rem;
		overflow-x: auto;
		border: 1px solid var(--color-border);
		border-radius: 6px;
	}

	.text pre {
		margin: 0;
		padding: 0.75rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
