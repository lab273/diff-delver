<!--
	Choosing what to review in one repository (DESIGN 3.1): its branches, the
	chosen branch's commits newest first with their sizes and times, a run of
	them to tick, or the whole branch compared with the main branch; and when
	the repository last fetched, with a button that asks its remote whether it
	has moved on. It opens nothing until the person presses a button, and
	never writes to the repository.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import { describeApiError } from '#lib/api/client.ts';
	import type { BranchView, CommitView, RemoteCheckView } from '#lib/api/schemas.ts';
	import { branchName, type BranchRef } from '#lib/core/history/branch-ref.tiny.ts';
	import {
		describeCut,
		describeReviewButton,
		describeSelection,
		describeSelectionProblem,
		isSelected,
		NOTHING_SELECTED,
		selectedCount,
		selectionSource,
		toggle,
		type CommitSelection
	} from '#lib/core/history/commit-selection.ts';
	import {
		describeAhead,
		describeCheckButton,
		describeExactTime,
		describeForkPoint,
		describeLastCommit,
		describeLastFetch,
		describeWholeBranch,
		UNKNOWN_COMMIT_TIME
	} from '#lib/core/history/history-words.ts';
	import { describeComparison, hasNews } from '#lib/core/history/remote-check.ts';
	import { itemIndexAt } from '#lib/core/item-index.tiny.ts';
	import { parseRevision } from '#lib/core/revision.tiny.ts';
	import type { DiffSize as SizeOfDiff } from '#lib/core/reports/report.ts';
	import { formatGitSourceSpec, type GitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
	import { describeTimeAgo } from '#lib/core/time-ago.ts';
	import { formatCount } from '#lib/core/viewer/words.ts';
	import CopyCommand from '#lib/ui/CopyCommand.svelte';
	import DiffSize from '#lib/ui/DiffSize.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import VisibleText from '#lib/ui/VisibleText.svelte';
	import { pageClient } from '#lib/ui/client.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const directory = untrack(() => data.directory);
	const loaded = untrack(() => (data.history?.ok === true ? data.history.value : undefined));
	const first = untrack(() => data.commits);

	let branches: readonly BranchView[] = $state(loaded?.branches ?? []);
	let matching = $state(loaded?.matching ?? 0);
	let find = $state('');
	let finding = $state(false);
	let findProblem = $state('');

	let branch: BranchRef | undefined = $state(first?.branch);
	let rows: readonly CommitView[] = $state(first?.page.ok === true ? first.page.value.commits : []);
	let next = $state(first?.page.ok === true ? first.page.value.next : null);
	let commitsProblem = $state(
		first !== undefined && !first.page.ok ? describeApiError(first.page.error) : ''
	);
	let loadingCommits = $state(false);
	let loadingMore = $state(false);

	let selection: CommitSelection = $state(NOTHING_SELECTED);
	let cutNote = $state('');
	let size: SizeOfDiff | undefined = $state();
	let measuring = $state(false);

	let opening = $state(false);
	let problem = $state('');

	let checking = $state(false);
	let checked: RemoteCheckView | undefined = $state();
	let checkProblem = $state('');

	const shownBranch = $derived(branches.find((b) => b.ref === branch));
	const main = loaded?.main ?? undefined;
	const isMain = $derived(shownBranch?.main ?? (branch !== undefined && branch === main));
	/** The first row the main branch has too, where the branch's own commits end. */
	const forkAt = $derived(main === undefined || isMain ? -1 : rows.findIndex((row) => row.onMain));
	const count = $derived(selectedCount(selection));

	function diffSizeOf(view: CommitView['size']): SizeOfDiff | undefined {
		return view === null
			? undefined
			: { files: view.files, addedLines: view.added, deletedLines: view.removed };
	}

	let finds = 0;
	let findTimer: ReturnType<typeof setTimeout> | undefined;

	/** Finds branches by name a moment after the typing stops, so each key does not ask. */
	function findBranches(): void {
		if (directory === undefined) return;
		finding = true;
		clearTimeout(findTimer);
		const asked = (finds += 1);
		const wanted = find;
		findTimer = setTimeout(() => {
			void pageClient()
				.history({ directory, find: wanted })
				.then((found) => {
					if (asked !== finds) return;
					finding = false;
					if (!found.ok) {
						findProblem = describeApiError(found.error);
						return;
					}
					findProblem = '';
					branches = found.value.branches;
					matching = found.value.matching;
				});
		}, 200);
	}

	let commitLoads = 0;

	async function chooseBranch(ref: BranchRef): Promise<void> {
		if (directory === undefined || ref === branch) return;
		branch = ref;
		selection = NOTHING_SELECTED;
		cutNote = '';
		size = undefined;
		problem = '';
		loadingCommits = true;
		const asked = (commitLoads += 1);
		const page = await pageClient().commits({ directory, branch: ref, from: undefined });
		if (asked !== commitLoads) return;
		loadingCommits = false;
		if (!page.ok) {
			rows = [];
			next = null;
			commitsProblem = describeApiError(page.error);
			return;
		}
		commitsProblem = '';
		rows = page.value.commits;
		next = page.value.next;
	}

	async function showMore(): Promise<void> {
		if (directory === undefined || branch === undefined || next === null || loadingMore) return;
		loadingMore = true;
		const asked = commitLoads;
		const page = await pageClient().commits({ directory, branch, from: next });
		loadingMore = false;
		if (asked !== commitLoads) return;
		if (!page.ok) {
			commitsProblem = describeApiError(page.error);
			return;
		}
		commitsProblem = '';
		rows = [...rows, ...page.value.commits];
		next = page.value.next;
	}

	let measures = 0;

	/** The size of the diff the chosen commits make: one commit's own, or asked for a run. */
	async function measure(): Promise<void> {
		const asked = (measures += 1);
		size = undefined;
		if (selection.kind === 'none' || directory === undefined) {
			measuring = false;
			return;
		}
		const newest = rows[selection.newest];
		const oldest = rows[selection.oldest];
		if (newest === undefined || oldest === undefined) return;
		if (selection.newest === selection.oldest) {
			measuring = false;
			size = diffSizeOf(newest.size);
			return;
		}
		if (oldest.parent.kind === 'not-downloaded') {
			measuring = false;
			return;
		}
		measuring = true;
		const measured = await pageClient().runSize({
			directory,
			from: oldest.parent.kind === 'commit' ? oldest.parent.commit : undefined,
			to: newest.commit
		});
		if (asked !== measures) return;
		measuring = false;
		size = measured.ok ? diffSizeOf(measured.value.size) : undefined;
	}

	function press(index: number): void {
		const toggled = toggle(selection, itemIndexAt(index));
		selection = toggled.selection;
		cutNote = describeCut(toggled.cut) ?? '';
		void measure();
	}

	/** Opens a source, as the start page does, and goes to its diff. */
	async function open(spec: GitSourceSpec): Promise<void> {
		if (opening || directory === undefined) return;
		opening = true;
		problem = '';
		const opened = await pageClient().open({ directory, source: formatGitSourceSpec(spec) });
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

	function reviewTicked(): void {
		const spec = selectionSource(rows, selection);
		if (!spec.ok) {
			problem = describeSelectionProblem(spec.error);
			return;
		}
		void open(spec.value);
	}

	function reviewWholeBranch(): void {
		if (main === undefined || branch === undefined) return;
		const from = parseRevision(main);
		const to = parseRevision(branch);
		if (from.ok && to.ok) void open({ kind: 'range', from: from.value, to: to.value });
	}

	async function checkRemotes(): Promise<void> {
		if (checking || directory === undefined) return;
		checking = true;
		checkProblem = '';
		const result = await pageClient().checkRemotes({ directory });
		checking = false;
		if (!result.ok) {
			checkProblem = describeApiError(result.error);
			return;
		}
		checked = result.value;
	}
</script>

<svelte:head>
	<title>
		{loaded === undefined
			? 'Choose what to review – diff delver'
			: `${loaded.repository}: choose what to review – diff delver`}
	</title>
</svelte:head>

{#if directory === undefined || data.history === undefined}
	<h1>Choose what to review</h1>
	<p>
		This page needs a repository. In a terminal, in your repository, run
		<code>diff-delver choose</code>.
	</p>
	<p><a href={resolve('/')}>See the diffs you have opened before</a></p>
{:else if !data.history.ok}
	<h1>Choose what to review</h1>
	<Notice tone="danger" heading="This repository cannot be read">
		<p>{describeApiError(data.history.error)}</p>
	</Notice>
	<p><a href={resolve('/')}>See the diffs you have opened before</a></p>
{:else if loaded !== undefined}
	{@const now = loaded.now}
	{@const fetched = describeLastFetch(loaded.lastFetch, now)}
	<h1>Choose what to review in {loaded.repository}</h1>
	<p class="lead">
		Choose a branch, then tick the commits to review. Tick two to review them and every commit
		between.
	</p>

	{#if fetched !== undefined}
		<section class="remote" aria-label="Your copy and its remote">
			<p class="fetched">{fetched}</p>
			<button type="button" aria-disabled={checking} onclick={checkRemotes}>
				{describeCheckButton(loaded.remotes)}
			</button>
			<div class="checked" role="status" aria-busy={checking}>
				{#if checking}
					<p>Asking {loaded.remotes.length === 1 ? loaded.remotes[0] : 'the remotes'}…</p>
				{:else if checkProblem !== ''}
					<p>{checkProblem}</p>
				{:else if checked !== undefined}
					{#each checked.remotes as outcome (outcome.remote)}
						<p>
							{outcome.kind === 'compared' ? describeComparison(outcome) : outcome.problem}
						</p>
					{/each}
					{#if checked.remotes.some((o) => o.kind === 'compared' && hasNews(o))}
						<p>
							To copy them here, run this in a terminal in your repository, then reload this page:
						</p>
						<CopyCommand command="git fetch" label="Copy the command" />
					{/if}
				{/if}
			</div>
		</section>
	{/if}

	<div class="columns">
		<section class="branches" aria-labelledby="branches-heading">
			<h2 id="branches-heading">Branches</h2>
			<label class="find">
				<span>Find a branch</span>
				<input type="search" bind:value={find} oninput={findBranches} autocomplete="off" />
			</label>
			<div aria-busy={finding}>
				{#if findProblem !== ''}
					<p class="problem">{findProblem}</p>
				{:else if branches.length === 0}
					<p class="quiet">
						{find.trim() === ''
							? 'This repository has no branches yet.'
							: 'No branch has that in its name.'}
					</p>
				{:else}
					<fieldset>
						<legend class="visually-hidden">Branch to show</legend>
						{#each branches as listed (listed.ref)}
							<label class="branch" class:chosen={listed.ref === branch}>
								<input
									type="radio"
									name="branch"
									value={listed.ref}
									checked={listed.ref === branch}
									onchange={() => {
										void chooseBranch(listed.ref);
									}}
								/>
								<span class="branch-text">
									<span class="branch-name">
										<VisibleText text={branchName(listed.ref)} />
										{#if listed.current}<span class="tag">Checked out</span>{/if}
										{#if listed.main}<span class="tag">Main branch</span>{/if}
									</span>
									<span class="branch-details">
										{#if listed.ahead !== null && main !== undefined && !listed.main}
											{describeAhead(listed.ahead, main)},
										{/if}
										{describeLastCommit(listed.committedAt ?? undefined, now)}
									</span>
								</span>
							</label>
						{/each}
					</fieldset>
					{#if matching > branches.length}
						<p class="quiet">
							Showing {formatCount(branches.length)} of {formatCount(matching)} branches. Type part of
							a name to find another.
						</p>
					{/if}
				{/if}
			</div>
		</section>

		<section class="commits" aria-labelledby="commits-heading" aria-busy={loadingCommits}>
			{#if branch !== undefined}
				<h2 id="commits-heading">Commits on <VisibleText text={branchName(branch)} /></h2>
				{#if main !== undefined && !isMain && shownBranch?.ahead != null}
					{#if shownBranch.ahead > 0}
						<button
							type="button"
							class="primary whole"
							aria-disabled={opening}
							onclick={reviewWholeBranch}
						>
							{describeWholeBranch(main, shownBranch.ahead)}
						</button>
						<p class="quiet">Or tick commits below to review only those.</p>
					{:else}
						<p class="quiet">
							This branch has no commits that {branchName(main)} lacks. Tick commits below to review them.
						</p>
					{/if}
				{/if}

				<div class="chosen-bar" aria-label="Ticked commits" role="region">
					<p role="status" aria-busy={measuring}>
						{describeSelection(rows, selection, size)}{measuring ? '…' : ''}
					</p>
					{#if cutNote !== ''}
						<p class="note">{cutNote}</p>
					{/if}
					<button
						type="button"
						class="primary"
						aria-disabled={count === 0 || opening}
						onclick={() => {
							if (count > 0) reviewTicked();
						}}
					>
						{describeReviewButton(selection)}
					</button>
				</div>
				{#if problem !== ''}
					<Notice tone="danger" heading="That could not be opened">
						<p>{problem}</p>
					</Notice>
				{/if}

				{#if commitsProblem !== ''}
					<p class="problem">{commitsProblem}</p>
				{/if}
				<ol class="rows">
					{#each rows as row, index (row.commit)}
						{#if index === forkAt && main !== undefined}
							<li class="fork">{describeForkPoint(branch, main)}</li>
						{/if}
						<li class="row" class:ticked={isSelected(selection, itemIndexAt(index))}>
							<label>
								<input
									type="checkbox"
									checked={isSelected(selection, itemIndexAt(index))}
									onchange={() => {
										press(index);
									}}
								/>
								<span class="row-text">
									<span class="subject">
										{#if row.subject.trim() === ''}<span class="quiet">
												No message
											</span>{:else}<VisibleText text={row.subject} />{/if}
										{#if row.merge}<span class="tag">Merge</span>{/if}
									</span>
									<span class="row-details">
										<code>{row.commit.slice(0, 7)}</code>
										<span><VisibleText text={row.author} /></span>
										{#if row.committedAt === null}
											<span>{UNKNOWN_COMMIT_TIME}</span>
										{:else}
											<span>
												{describeTimeAgo(row.committedAt, now)}
												<span class="exact">({describeExactTime(row.committedAt)})</span>
											</span>
										{/if}
										{#if row.size !== null}
											<span>
												<DiffSize added={row.size.added} removed={row.size.removed} />
												{row.size.files === 1 ? '1 file' : `${formatCount(row.size.files)} files`}
											</span>
										{/if}
									</span>
									{#if row.parent.kind === 'not-downloaded'}
										<span class="note">
											The history before this commit was not downloaded: this is a shallow clone.
										</span>
									{/if}
								</span>
							</label>
						</li>
					{/each}
				</ol>
				{#if rows.length === 0 && commitsProblem === '' && !loadingCommits}
					<p class="quiet">This branch has no commits.</p>
				{/if}
				{#if next !== null}
					<button
						type="button"
						aria-disabled={loadingMore}
						aria-busy={loadingMore}
						onclick={showMore}
					>
						Show older commits
					</button>
				{/if}
			{/if}
		</section>
	</div>
	<p><a href={resolve('/')}>See the diffs you have opened before</a></p>
{/if}

<style>
	h1 {
		margin: 0 0 0.5rem;
		font-size: 1.75rem;
	}

	h2 {
		font-size: 1.125rem;
		margin: 0 0 0.5rem;
	}

	.lead {
		margin: 0 0 1rem;
	}

	.remote {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 1rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-subtle);
		padding: 0.5rem 1rem;
		margin: 0 0 1.5rem;
	}

	.fetched {
		margin: 0;
		flex: 1 1 20rem;
	}

	.checked {
		flex: 1 1 100%;
	}

	.checked:empty {
		display: none;
	}

	.checked p {
		margin: 0.25rem 0;
	}

	.columns {
		display: grid;
		grid-template-columns: minmax(14rem, 18rem) 1fr;
		gap: 1.5rem;
		align-items: start;
	}

	@media (max-width: 48rem) {
		.columns {
			grid-template-columns: 1fr;
		}
	}

	.find {
		display: grid;
		gap: 0.25rem;
		margin-bottom: 0.75rem;
		font-size: 0.875rem;
		font-weight: 700;
	}

	.find input {
		font-weight: 400;
		padding: 0.3rem 0.5rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-background);
		color: var(--color-text);
	}

	fieldset {
		border: 0;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.25rem;
	}

	.branch {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
		padding: 0.4rem 0.5rem;
		border-radius: 6px;
		cursor: pointer;
	}

	.branch.chosen {
		background: var(--color-selected-button);
	}

	.branch input {
		margin-top: 0.3rem;
	}

	.branch-text,
	.row-text {
		display: grid;
		min-width: 0;
	}

	.branch-name {
		font-weight: 700;
		overflow-wrap: anywhere;
	}

	.branch-details,
	.row-details {
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	.row-details {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.75rem;
	}

	.tag {
		display: inline-block;
		margin-left: 0.25rem;
		font-size: 0.75rem;
		font-weight: 700;
		border: 1px solid var(--color-border);
		border-radius: 2rem;
		padding: 0 0.5rem;
		color: var(--color-muted);
		vertical-align: 1px;
	}

	.quiet {
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	.problem {
		color: var(--color-removed);
	}

	.note {
		margin: 0.25rem 0 0;
		font-size: 0.875rem;
	}

	.primary {
		background: var(--color-primary-button);
		border-color: var(--color-primary-button);
		color: var(--color-on-primary-button);
	}

	.primary:hover {
		background: var(--color-primary-button-hover);
	}

	.whole {
		display: block;
		width: 100%;
		margin: 0 0 0.25rem;
		padding: 0.5rem 0.9rem;
	}

	.chosen-bar {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-background);
		padding: 0.5rem 0.75rem;
		margin: 0.75rem 0;
	}

	.chosen-bar p[role='status'] {
		margin: 0;
		flex: 1 1 16rem;
		font-size: 0.875rem;
	}

	.chosen-bar .note {
		flex: 1 1 100%;
		order: 3;
	}

	.rows {
		list-style: none;
		margin: 0 0 1rem;
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: 6px;
	}

	.rows li + li {
		border-top: 1px solid var(--color-border);
	}

	.row label {
		display: flex;
		gap: 0.6rem;
		align-items: flex-start;
		padding: 0.5rem 0.75rem;
		cursor: pointer;
	}

	.row input {
		margin-top: 0.3rem;
	}

	.row.ticked {
		background: var(--color-selected-button);
	}

	.subject {
		font-weight: 700;
		overflow-wrap: anywhere;
	}

	.exact {
		white-space: nowrap;
	}

	.fork {
		padding: 0.4rem 0.75rem;
		background: var(--color-subtle);
		color: var(--color-muted);
		font-size: 0.8125rem;
	}
</style>
