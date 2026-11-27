<!--
	A Delve's history (DESIGN 6.4): its versions and finished reviews in the
	order they happened. Each version says when it arrived and what it brought;
	each review when it was finished and on which version, what it held, how far
	the review had got, how it was handed over and where its comments stand
	today, with the way to read it and to see the Delve as it stood then.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { describeApiError } from '#lib/api/client.ts';
	import { describeUnitProgress } from '#lib/core/reports/describe-report.ts';
	import { describeExactTime } from '#lib/core/history/history-words.ts';
	import { describeTimeAgo } from '#lib/core/time-ago.ts';
	import ReviewAccess from '#lib/ui/ReviewAccess.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>
		{data.history.ok ? `History of ${data.history.value.title}` : 'History'} – diff delver
	</title>
</svelte:head>

{#if !data.history.ok}
	<h1 tabindex="-1">History</h1>
	{#if !data.canReview}
		<ReviewAccess diff={data.id} what="comments" />
	{:else}
		<p>{describeApiError(data.history.error)}</p>
	{/if}
	<p><a href={resolve('/diffs/[id]', { id: data.id })}>Back to the Delve</a></p>
{:else}
	{@const history = data.history.value}
	<h1 tabindex="-1">History of {history.title}</h1>
	<p class="lead">
		Every version of this Delve and every review you finished, oldest first.
		<a href={resolve('/diffs/[id]', { id: data.id })}>Back to the Delve</a>
	</p>
	<ol class="timeline" aria-label="Versions and reviews">
		{#each history.entries as entry (entry.kind === 'version' ? `v${entry.version}` : `r${entry.review.number}`)}
			{#if entry.kind === 'version'}
				<li class="version" aria-labelledby="version-{entry.version}">
					<h2 id="version-{entry.version}">
						Version {entry.version}{entry.version === history.version ? ', the current one' : ''}
					</h2>
					<p class="when">
						Arrived {describeTimeAgo(entry.arrivedAt, history.now)}
						<span class="exact">({describeExactTime(entry.arrivedAt)})</span>
					</p>
					<p>{entry.text}</p>
				</li>
			{:else}
				{@const review = entry.review}
				<li class="review" aria-labelledby="review-{review.number}">
					<h2 id="review-{review.number}">Review {review.number}</h2>
					<p class="when">
						Finished {describeTimeAgo(review.submittedAt, history.now)} on version {review.version}
						<span class="exact">({describeExactTime(review.submittedAt)})</span>
					</p>
					<p>
						Held {entry.held}.
						{describeUnitProgress(review.progress)} then.
					</p>
					{#if entry.today !== null}
						<p>{entry.today}.</p>
					{/if}
					{#if entry.deliveries.length > 0}
						<ul class="deliveries" aria-label="How review {review.number} was handed over">
							{#each entry.deliveries as delivery (delivery)}
								<li>{delivery}</li>
							{/each}
						</ul>
					{/if}
					<p class="links">
						<a
							href={resolve('/diffs/[id]/reviews/[review]', {
								id: data.id,
								review: String(review.number)
							})}
						>
							Read review {review.number}
						</a>
						<a href="{resolve('/diffs/[id]', { id: data.id })}?review={review.number}">
							See the Delve as of review {review.number}
						</a>
					</p>
				</li>
			{/if}
		{/each}
	</ol>
	{#if !history.entries.some((e) => e.kind === 'review')}
		<p>
			No review is finished yet. When you finish one with “Finish and copy” on the Delve’s page, it
			is listed here.
		</p>
	{/if}
{/if}

<style>
	h1 {
		margin: 0 0 0.5rem;
		font-size: 1.75rem;
	}

	.lead {
		margin: 0 0 1rem;
		color: var(--color-muted);
	}

	.timeline {
		list-style: none;
		margin: 0;
		padding: 0 0 0 1rem;
		border-left: 2px solid var(--color-border);
		max-width: 46rem;
	}

	.timeline > li {
		position: relative;
		margin: 0 0 1.25rem;
		padding-left: 0.75rem;
	}

	.timeline > li::before {
		content: '';
		position: absolute;
		left: calc(-1rem - 6px);
		top: 0.45rem;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--color-border);
	}

	.timeline > li.review::before {
		background: var(--color-link);
	}

	h2 {
		font-size: 1.125rem;
		margin: 0;
	}

	p {
		margin: 0.25rem 0;
	}

	.when,
	.exact {
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.deliveries {
		margin: 0.25rem 0;
		padding-left: 1.25rem;
	}

	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
	}
</style>
