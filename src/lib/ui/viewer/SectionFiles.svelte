<script lang="ts">
	import type { PartIndex } from '#lib/core/part-index.tiny.ts';
	import PathText from '#lib/ui/PathText.svelte';
	import type { GroupInfo, Viewer } from './viewer.svelte.ts';

	let {
		viewer,
		group,
		ongo
	}: {
		viewer: Viewer;
		group: GroupInfo;
		ongo: (at: PartIndex) => void;
	} = $props();

	const PAGE_SIZE = 30;
	let open = $state(false);
	let page = $state(0);
	const lastPage = $derived(Math.max(0, Math.ceil(group.count / PAGE_SIZE) - 1));
	const current = $derived(Math.min(page, lastPage));
	const first = $derived(current * PAGE_SIZE);
	const end = $derived(Math.min(first + PAGE_SIZE, group.count));
</script>

<button
	type="button"
	class="disclosure"
	aria-label="Files in {group.name}"
	aria-expanded={open}
	aria-controls="{group.anchor}-files"
	onclick={() => (open = !open)}
>
	<span aria-hidden="true" class="chevron"></span> Files ({group.count})
</button>
<div id="{group.anchor}-files" hidden={!open}>
	{#if open}
		<ul>
			{#each viewer.parts.slice(group.first + first, group.first + end) as { index, part, key } (key)}
				<li>
					<a
						href="#part-{index}"
						onclick={(event) => {
							if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
							event.preventDefault();
							ongo(index);
						}}
					>
						<PathText path={part.path} />
						{#if part.step !== null}
							<span> Step {part.step}</span>
						{/if}
						{#if part.of > 1}
							<span> Part {part.position} of {part.of}</span>
						{/if}
					</a>
				</li>
			{/each}
		</ul>
		{#if lastPage > 0}
			<p aria-live="polite">{first + 1}–{end} of {group.count} files</p>
			<div class="pages">
				<button
					type="button"
					aria-disabled={current === 0}
					onclick={() => {
						if (current > 0) page = current - 1;
					}}
				>
					Previous files
				</button>
				<button
					type="button"
					aria-disabled={current === lastPage}
					onclick={() => {
						if (current < lastPage) page = current + 1;
					}}
				>
					Next files
				</button>
			</div>
		{/if}
	{/if}
</div>

<style>
	.disclosure {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		align-self: start;
		margin-top: 0.2rem;
		padding: 0 0.25rem;
		border: 0;
		background: none;
		font-size: 0.8125rem;
	}

	.chevron {
		width: 0.35rem;
		height: 0.35rem;
		border: solid currentColor;
		border-width: 0 1px 1px 0;
		transform: rotate(-45deg);
	}

	[aria-expanded='true'] .chevron {
		transform: rotate(45deg);
	}

	ul {
		list-style: none;
		margin: 0.2rem 0;
		padding: 0 0 0 0.75rem;
		border-left: 1px solid var(--color-border);
		max-block-size: 12rem;
		overflow: auto;
	}

	a {
		display: block;
		padding-block: 0.2rem;
		overflow-wrap: anywhere;
	}

	a span {
		display: block;
		color: var(--color-muted);
	}

	p {
		margin: 0.25rem 0;
	}

	.pages {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}
</style>
