<!--
	What the command opens when it cannot open one diff straight away: a short
	chooser when several changes could be reviewed, why there is nothing to
	review here, or why what was asked for could not be opened, with what to do
	instead. It never opens anything by itself.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { describeApiError } from '#lib/api/client.ts';
	import type { Candidate } from '#lib/api/schemas.ts';
	import { describeGitSource } from '#lib/core/sources/git-source-spec.ts';
	import { describeNothingToReview } from '#lib/core/reports/describe-report.ts';
	import Notice from '#lib/ui/Notice.svelte';
	import { pageClient } from '#lib/ui/client.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let opening = $state(false);
	let problem = $state('');

	const candidates = $derived.by((): readonly Candidate[] => {
		if (!data.suggested.ok) return [];
		const s = data.suggested.value.suggestion;
		switch (s.kind) {
			case 'one':
				return [s.candidate, ...s.others];
			case 'choose':
			case 'nothing':
				return s.candidates;
		}
	});

	async function choose(candidate: Candidate): Promise<void> {
		opening = true;
		problem = '';
		const opened = await pageClient().open({ directory: data.directory, source: candidate.source });
		opening = false;
		if (!opened.ok) {
			problem = describeApiError(opened.error);
			return;
		}
		if (opened.value.kind === 'opened') {
			await goto(resolve('/diffs/[id]', { id: opened.value.diff.id }));
			return;
		}
		problem = opened.value.reason;
	}
</script>

<svelte:head>
	<title>
		{data.suggested.ok
			? `${data.suggested.value.repository}: what to review – diff delver`
			: 'Nothing to review – diff delver'}
	</title>
</svelte:head>

{#if !data.suggested.ok}
	<h1>Nothing to review here</h1>
	<p>{describeApiError(data.suggested.error)}</p>
	<p><a href={resolve('/')}>See the diffs you have opened before</a></p>
{:else}
	{@const { repository, suggestion, asked } = data.suggested.value}
	{@const instead = data.asked !== undefined || suggestion.kind === 'nothing'}
	{#if asked?.problem != null}
		<h1>
			{data.asked === undefined
				? `What you asked for could not be opened in ${repository}`
				: `${describeGitSource(data.asked)} could not be opened in ${repository}`}
		</h1>
		<p>{asked.problem}</p>
	{:else if data.asked !== undefined}
		<h1>Nothing to review in {repository}: {describeGitSource(data.asked)}</h1>
		<p>{describeNothingToReview(data.asked)}</p>
	{:else if suggestion.kind === 'nothing'}
		<h1>Nothing to review in {repository}</h1>
		<p>{suggestion.reason}</p>
	{:else}
		<h1>What would you like to review in {repository}?</h1>
		<p>
			{candidates.length === 1
				? 'This can be reviewed here. Choose it to open it.'
				: 'There are several changes here. Choose one to open it.'}
		</p>
	{/if}

	{#if candidates.length > 0}
		{#if instead}
			<h2>You could review instead</h2>
		{/if}
		<ul class="candidates">
			{#each candidates as candidate (candidate.source)}
				<li>
					<button
						type="button"
						disabled={opening}
						onclick={() => {
							void choose(candidate);
						}}
					>
						{candidate.description}
					</button>
				</li>
			{/each}
		</ul>
	{:else if data.asked !== undefined}
		<p>There is nothing else to review here either.</p>
	{/if}
	{#if problem !== ''}
		<Notice tone="danger" heading="That could not be opened">
			<p>{problem}</p>
		</Notice>
	{/if}
	<p><a href={resolve('/')}>See the diffs you have opened before</a></p>
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

	.candidates {
		list-style: none;
		padding: 0;
		margin: 1rem 0;
		display: grid;
		gap: 0.5rem;
	}

	.candidates button {
		width: 100%;
		text-align: left;
		padding: 0.75rem 1rem;
		font-size: 1rem;
	}
</style>
