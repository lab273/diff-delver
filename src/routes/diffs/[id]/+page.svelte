<!--
	A diff's page, before the viewer: what it is, how big, anything left out of
	it, whether its files have changed (with Update) or it is closed, what the
	last update did, and its files as its groups list them, each with what is
	new in it since the previous version. The next build step replaces the file
	list with the diff itself.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto, invalidate } from '$app/navigation';
	import { tick } from 'svelte';
	import { describeApiError } from '#lib/api/client.ts';
	import type { ChangeCheckResponse, NextSourceOffer } from '#lib/api/schemas.ts';
	import { describeTimeAgo } from '#lib/core/time-ago.ts';
	import DiffSize from '#lib/ui/DiffSize.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import { ChangeChecks, type Shown } from '#lib/ui/change-checks.ts';
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

	/** Once a minute while the page is in view, besides whenever the person comes back to it. */
	const LOOK_AGAIN_EVERY = 60_000;
	const UPDATED_HEADING = 'updated-heading';

	const checks = new ChangeChecks();

	function shown(): Shown {
		return { id: data.id, version: data.loaded.ok ? data.loaded.value.summary.version : undefined };
	}

	/**
	 * Asks whether this diff has a newer version than the page shows, and if not,
	 * whether its files have changed. Looking again in the background keeps what
	 * is shown when the answer cannot be had, rather than flickering, and is not
	 * done while a check is under way. An answer for a diff or version the page
	 * no longer shows is dropped (`change-checks.ts`).
	 */
	async function checkForChanges(quietly = false): Promise<void> {
		const ticket = checks.start(shown(), quietly);
		if (ticket === undefined) return;
		const checked = await pageClient().checkForChanges(ticket.shown.id, ticket.shown.version);
		if (!checks.finish(ticket, shown())) return;
		if (checked.ok) check = checked.value;
		else if (!quietly) check = { kind: 'failed', message: describeApiError(checked.error) };
	}

	// Again for each diff and version this page shows: opening another one reuses the page.
	$effect(() => {
		void shown();
		check = { kind: 'checking' };
		void checkForChanges();
	});

	// Nothing changes under the person reading: the page only says that something
	// did, when they come back to it or now and then, and changes on their word.
	$effect(() => {
		const again = (): void => {
			if (document.visibilityState === 'visible' && !busy) void checkForChanges(true);
		};
		window.addEventListener('focus', again);
		document.addEventListener('visibilitychange', again);
		const timer = setInterval(again, LOOK_AGAIN_EVERY);
		return () => {
			window.removeEventListener('focus', again);
			document.removeEventListener('visibilitychange', again);
			clearInterval(timer);
		};
	});

	async function act(action: () => Promise<{ ok: boolean; message?: string }>): Promise<void> {
		busy = true;
		problem = '';
		const done = await action();
		busy = false;
		if (!done.ok) problem = done.message ?? '';
	}

	/** Shows the version the page now has and moves focus to what the update did. */
	async function showNewVersion(): Promise<void> {
		await invalidate('app:diff');
		await tick();
		document.getElementById(UPDATED_HEADING)?.focus();
	}

	async function showNewer(): Promise<void> {
		await act(async () => {
			await showNewVersion();
			return { ok: true };
		});
	}

	async function update(): Promise<void> {
		await act(async () => {
			const updated = await pageClient().updateDiff(data.id);
			if (!updated.ok) return { ok: false, message: describeApiError(updated.error) };
			switch (updated.value.kind) {
				case 'updated':
					await showNewVersion();
					return { ok: true };
				case 'unchanged':
					check = { kind: 'unchanged' };
					return { ok: true };
				case 'nothing-left':
					check = {
						kind: 'nothing-left',
						reason: updated.value.reason,
						next: updated.value.next
					};
					return { ok: true };
			}
		});
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

	function fileCount(count: number): string {
		return count === 1 ? '1 file' : `${String(count)} files`;
	}

	function newChanges(count: number, version: number): string {
		return `${count === 1 ? '1 new change' : `${String(count)} new changes`} since version ${String(version - 1)}`;
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
	{@const updated = page.update}
	<div class="heading">
		<h1>{summary.title}</h1>
		<span class="state {summary.state.kind}">
			{summary.state.kind === 'open' ? 'Open' : 'Closed'}
		</span>
	</div>
	<p class="details">
		<span>{summary.repository}</span>
		<span>{summary.sizeText}</span>
		{#if summary.version > 1}
			<span>Version {summary.version}</span>
		{/if}
		<span>Last active {describeTimeAgo(summary.lastActivityAt, page.now)}</span>
	</p>
	<p class="progress">{summary.progressText}</p>

	{#if check.kind === 'updated'}
		<Notice heading="This diff has a newer version">
			<p>
				It was updated to version {check.version} while this page was open, so what you see here, version
				{summary.version}, is out of date.
			</p>
			{#snippet actions()}
				<button type="button" disabled={busy} onclick={showNewer}>Show the new version</button>
			{/snippet}
		</Notice>
	{:else if summary.state.kind === 'closed'}
		<Notice heading="This diff is closed">
			<p>{summary.state.reason} You can still read it.</p>
			{#snippet actions()}
				<button type="button" disabled={busy} onclick={() => setOpen(true)}>
					Reopen this diff
				</button>
			{/snippet}
		</Notice>
	{:else if check.kind === 'changed'}
		<Notice heading="Your files have changed">
			<p>
				What you see here is how they were before.
				{check.files === 0
					? 'None of the changes this diff shows are different, so updating brings nothing new to review.'
					: `Update to see the ${fileCount(check.files)} that changed as they are now. Lines you marked as reviewed stay marked, unless they or the lines close to them changed.`}
			</p>
			{#snippet actions()}
				<button type="button" disabled={busy} onclick={update}>Update</button>
			{/snippet}
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
			{#if busy && check.kind === 'changed'}
				Updating to your files as they are now…
			{:else if check.kind === 'checking'}
				Checking for changes in the repository…
			{:else if check.kind === 'unchanged'}
				{summary.version === 1
					? 'No changes in the repository since you opened it.'
					: 'No changes in the repository since this version was taken.'}
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

	{#if updated !== null}
		<Notice
			tone="info"
			headingId={UPDATED_HEADING}
			heading="Updated to version {updated.version} {describeTimeAgo(updated.at, page.now)}"
		>
			<p>{updated.text}</p>
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

	{#each page.groups as { key: group, title, parts: files }, index (index)}
		<section class="group" aria-labelledby="group-{index}">
			<h2 id="group-{index}">
				{group.kind === 'section' || group.kind === 'tests'
					? title
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
						<span class="change">{file.change}</span>
						{#if file.tally.fresh > 0 && group.kind !== 'ignored'}
							<span class="new">{newChanges(file.tally.fresh, summary.version)}</span>
						{/if}
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

	.new {
		color: var(--color-accent);
		border: 1px solid var(--color-accent);
		border-radius: 2rem;
		padding: 0 0.5rem;
		font-size: 0.75rem;
		font-weight: 700;
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
