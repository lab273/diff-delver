<!--
	A diff's page, before the viewer: what it is, how big, anything left out of
	it, whether it has changed or closed, and its files as its groups list them.
	The next build step replaces the file list with the diff itself.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { goto, invalidate } from '$app/navigation';
	import { describeApiError } from '#lib/api/client.ts';
	import type { ChangeCheckResponse, ListedFileView, NextSourceOffer } from '#lib/api/schemas.ts';
	import { describeTimeAgo } from '#lib/core/time-ago.ts';
	import DiffSize from '#lib/ui/DiffSize.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import { pageClient } from '#lib/ui/client.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Check =
		| { readonly kind: 'checking' }
		| ChangeCheckResponse
		| { readonly kind: 'failed'; readonly message: string };
	let check: Check = $state({ kind: 'checking' });
	let problem = $state('');
	let busy = $state(false);

	async function checkForChanges(): Promise<void> {
		const checked = await pageClient().checkForChanges(data.id);
		check = checked.ok
			? checked.value
			: { kind: 'failed', message: describeApiError(checked.error) };
	}

	onMount(() => {
		void checkForChanges();
	});

	async function act(action: () => Promise<{ ok: boolean; message?: string }>): Promise<void> {
		busy = true;
		problem = '';
		const done = await action();
		busy = false;
		if (!done.ok) problem = done.message ?? '';
	}

	async function setOpen(open: boolean): Promise<void> {
		await act(async () => {
			const client = pageClient();
			const changed = open ? await client.reopenDiff(data.id) : await client.closeDiff(data.id);
			if (!changed.ok) return { ok: false, message: describeApiError(changed.error) };
			await invalidate('app:diff');
			await checkForChanges();
			return { ok: true };
		});
	}

	async function openNext(next: NextSourceOffer, directory: string): Promise<void> {
		await act(async () => {
			const opened = await pageClient().open({ directory, source: next.source });
			if (!opened.ok) return { ok: false, message: describeApiError(opened.error) };
			if (opened.value.kind === 'nothing') return { ok: false, message: opened.value.reason };
			await goto(resolve('/diffs/[id]', { id: opened.value.diff.id }));
			return { ok: true };
		});
	}

	function change(file: ListedFileView): string {
		switch (file.status) {
			case 'added':
				return 'added';
			case 'deleted':
				return 'deleted';
			case 'modified':
				return 'changed';
			case 'renamed':
				return file.from === null ? 'renamed' : `renamed from ${file.from}`;
			case 'copied':
				return file.from === null ? 'copied' : `copied from ${file.from}`;
			case 'type-changed':
				return 'changed kind';
		}
	}

	function content(file: ListedFileView): string | undefined {
		switch (file.content) {
			case 'text':
				return undefined;
			case 'binary':
				return 'binary file';
			case 'submodule':
				return 'submodule';
		}
	}

	function fileCount(count: number): string {
		return count === 1 ? '1 file' : `${String(count)} files`;
	}
</script>

<svelte:head>
	<title>
		{data.loaded.ok
			? `${data.loaded.value.summary.title} in ${data.loaded.value.summary.repository} – diff delver`
			: 'Diff not found – diff delver'}
	</title>
</svelte:head>

{#if !data.loaded.ok}
	<h1>This diff cannot be shown</h1>
	<p>{describeApiError(data.loaded.error)}</p>
	<p><a href={resolve('/')}>See all your diffs</a></p>
{:else}
	{@const page = data.loaded.value}
	{@const summary = page.summary}
	<div class="heading">
		<h1>{summary.title}</h1>
		<span class="state {summary.state.kind}">
			{summary.state.kind === 'open' ? 'Open' : 'Closed'}
		</span>
	</div>
	<p class="details">
		<span>{summary.repository}</span>
		<span>{summary.sizeText}</span>
		<span>Last active {describeTimeAgo(summary.lastActivityAt, page.now)}</span>
	</p>
	<p class="progress">{summary.progressText}</p>

	{#if summary.state.kind === 'closed'}
		<Notice heading="This diff is closed">
			<p>{summary.state.reason} You can still read it.</p>
			{#snippet actions()}
				<button type="button" disabled={busy} onclick={() => setOpen(true)}>
					Reopen this diff
				</button>
			{/snippet}
		</Notice>
	{:else if check.kind === 'changed'}
		<Notice heading="This diff has changed since you opened it">
			<p>
				The files in the repository are not as they were when you opened it. What you see here is
				how they were then.
			</p>
		</Notice>
	{:else if check.kind === 'nothing-left'}
		{@const next = check.next}
		<Notice heading="Nothing is left to review here">
			<p>{check.reason}</p>
			{#snippet actions()}
				{#if next !== null}
					<button type="button" disabled={busy} onclick={() => openNext(next, page.directory)}>
						{next.offer}
					</button>
				{/if}
				<button type="button" disabled={busy} onclick={() => setOpen(false)}>
					Close this diff
				</button>
			{/snippet}
		</Notice>
	{/if}
	{#if summary.state.kind === 'open'}
		<p class="checked" role="status">
			{#if check.kind === 'checking'}
				Checking for changes in the repository…
			{:else if check.kind === 'unchanged'}
				No changes in the repository since you opened it.
			{:else if check.kind === 'failed'}
				Could not check for changes: {check.message}
			{/if}
		</p>
	{/if}
	{#if problem !== ''}
		<Notice tone="danger" heading="That did not work">
			<p>{problem}</p>
		</Notice>
	{/if}

	{#if page.leftOut.length > 0}
		<Notice heading="Some files could not be included">
			<ul>
				{#each page.leftOut as reason (reason)}
					<li>{reason}</li>
				{/each}
			</ul>
		</Notice>
	{/if}

	{#each page.groups as { group, files }, index (index)}
		<section class="group" aria-labelledby="group-{index}">
			<h2 id="group-{index}">
				{group.kind === 'section'
					? group.title
					: group.kind === 'ignored'
						? 'Ignored'
						: 'Not sorted yet'}
				<span class="count">{fileCount(files.length)}</span>
			</h2>
			{#if group.kind === 'uncategorised'}
				<p class="explain">
					{page.sorted
						? 'The agent did not place these, so they are listed here.'
						: 'No agent has sorted this diff into sections, so every file is listed here.'}
				</p>
			{:else if group.kind === 'ignored'}
				<p class="explain">These need no review; each says why.</p>
			{/if}
			<ul class="files">
				{#each files as file (file.path)}
					<li>
						<span class="path">{file.path}</span>
						<span class="change">
							{change(file)}{content(file) === undefined ? '' : `, ${content(file) ?? ''}`}
						</span>
						{#each file.ignored as reason, r (r)}
							<span class="reason">
								{reason.kind === 'agent' ? `Agent: ${reason.reason}` : reason.text}
							</span>
						{/each}
						<span class="lines"><DiffSize added={file.added} removed={file.removed} /></span>
					</li>
				{/each}
			</ul>
		</section>
	{/each}
	<p><a href={resolve('/')}>See all your diffs</a></p>
{/if}

<style>
	.heading {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	h1 {
		margin: 0;
		font-size: 1.75rem;
	}

	.state {
		font-size: 0.875rem;
		font-weight: 700;
		border: 1px solid var(--color-border);
		border-radius: 2rem;
		padding: 0 0.6rem;
	}

	.state.open {
		color: var(--color-added);
		border-color: var(--color-added);
	}

	.details {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1rem;
		margin: 0.5rem 0 0;
		color: var(--color-muted);
	}

	.progress {
		margin: 0.25rem 0 0;
	}

	.checked {
		margin: 0.5rem 0 0;
		min-height: 1.5rem;
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.group {
		margin-top: 1.5rem;
	}

	.group h2 {
		font-size: 1.125rem;
		margin: 0 0 0.25rem;
	}

	.count {
		color: var(--color-muted);
		font-weight: 400;
		font-size: 0.875rem;
		margin-left: 0.5rem;
	}

	.explain {
		margin: 0 0 0.5rem;
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.files {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: 6px;
	}

	.files li {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0 0.75rem;
		padding: 0.4rem 1rem;
	}

	.files li + li {
		border-top: 1px solid var(--color-border);
	}

	.path {
		font-family: var(--font-code);
		font-size: 0.875rem;
		overflow-wrap: anywhere;
	}

	.change,
	.reason {
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.reason {
		border: 1px solid var(--color-border);
		border-radius: 2rem;
		padding: 0 0.5rem;
		font-size: 0.75rem;
	}

	.lines {
		margin-left: auto;
	}
</style>
