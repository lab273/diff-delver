<!--
	The by-file view (DESIGN 8.2): every file of the diff once, in path order,
	with how it changed, its size, how far its review has got, the groups its
	parts are in (each a way to that part), and a tick for the whole file. The
	direct answer to "is every file accounted for".
-->
<script lang="ts">
	import type { FileView, GroupKeyView } from '#lib/api/schemas.ts';
	import { describeTally } from '#lib/core/viewer/words.ts';
	import type { EscapedPath } from '#lib/core/path-bytes.ts';
	import { shownPath } from '#lib/core/shown-path.tiny.ts';
	import PathText from '#lib/ui/PathText.svelte';
	import DiffSize from '#lib/ui/DiffSize.svelte';
	import { tick } from 'svelte';
	import TickRefused from './TickRefused.svelte';
	import { done, partly, showTally, type Viewer } from './viewer.svelte.ts';

	let {
		viewer,
		ontick,
		ongo,
		onshownewer
	}: {
		viewer: Viewer;
		ontick: (file: FileView, reviewed: boolean) => Promise<void>;
		ongo: (path: EscapedPath, group: GroupKeyView) => void;
		/** Shows the diff's newer version, when a tick was refused for being behind it. */
		onshownewer: () => void;
	} = $props();

	/**
	 * When a tick takes the file from the list ("Only what I have not reviewed"),
	 * focus goes to the file that took its place (its tick, or the way to it when
	 * it has none), or the one before when it was the last, or the list's heading.
	 */
	function moveOnFrom(place: number): void {
		if (document.activeElement !== null && document.activeElement !== document.body) return;
		const rows = document.querySelectorAll('.by-file .files > li');
		const row = rows[place] ?? rows[place - 1];
		const next = row?.querySelector<HTMLElement>('input[type=checkbox], a');
		(next ?? document.getElementById('by-file-heading'))?.focus();
	}

	const shown = $derived(
		viewer.files.filter((f) => !viewer.onlyWaiting || (f.tally.units > 0 && !done(f.tally)))
	);
</script>

<section class="by-file" aria-labelledby="by-file-heading">
	<h2 id="by-file-heading" tabindex="-1">
		Every file <span class="count">
			{viewer.files.length === 1 ? '1 file' : `${viewer.files.length} files`}
		</span>
	</h2>
	<p class="explain">Each file once, with where its changes are. Ticking a file marks all of it.</p>
	{#if shown.length === 0}
		<p class="explain">Every file is reviewed.</p>
	{:else}
		<ul class="files">
			{#each shown as file, i (file.path)}
				<li>
					<span class="path"><PathText path={file.path} /></span>
					<span class="change">{file.change}</span>
					{#each file.parts as group, i (i)}
						<a
							class="chip"
							href="#{viewer.groupWithKey(group)?.anchor ?? ''}"
							aria-label="Go to {shownPath(file.path)} in {viewer.groupWithKey(group)?.name ??
								'another group'}"
							onclick={(event) => {
								event.preventDefault();
								ongo(file.path, group);
							}}
						>
							{viewer.groupWithKey(group)?.name ?? 'another group'}
						</a>
					{/each}
					<span class="size"><DiffSize added={file.added} removed={file.removed} /></span>
					{#if file.tally.units === 0}
						<span class="tally">Ignored, not counted</span>
					{:else}
						{#if !done(file.tally)}<span class="tally">{describeTally(file.tally)}</span>{/if}
						<label class="tick">
							<input
								type="checkbox"
								aria-label="Reviewed: {shownPath(file.path)}"
								checked={done(file.tally)}
								indeterminate={partly(file.tally)}
								onchange={async (event) => {
									const box = event.currentTarget;
									await ontick(file, box.checked);
									showTally(
										box,
										viewer.files.find((f) => f.path === file.path)?.tally ?? file.tally
									);
									await tick();
									moveOnFrom(i);
								}}
							/>
							Reviewed
						</label>
					{/if}
					{#if viewer.refused?.kind === 'file' && viewer.refused.key === file.path}
						{@const refused = viewer.refused}
						<div class="refused">
							<TickRefused message={refused.message} behind={refused.behind} {onshownewer} />
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	h2 {
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

	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
		padding: 0.4rem 0.75rem;
		font-size: 0.875rem;
	}

	li + li {
		border-top: 1px solid var(--color-border);
	}

	.path {
		font-family: var(--font-code);
		font-weight: 700;
		overflow-wrap: anywhere;
	}

	.change,
	.tally {
		color: var(--color-muted);
	}

	.chip {
		border: 1px solid var(--color-border);
		border-radius: 2rem;
		padding: 0 0.5rem;
		font-size: 0.75rem;
	}

	.size {
		margin-left: auto;
	}

	.tick {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-weight: 700;
	}

	.refused {
		flex-basis: 100%;
	}

	.tick input {
		width: 1rem;
		height: 1rem;
		margin: 0;
	}
</style>
