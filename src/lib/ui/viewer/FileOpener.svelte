<script lang="ts">
	import type { FileMatch } from '#lib/api/schemas.ts';
	import { describeApiError } from '#lib/api/client.ts';
	import type { ReportId } from '#lib/core/report-id.tiny.ts';
	import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
	import { FILE_QUERY_LENGTH } from '#lib/core/viewer/file-reader.ts';
	import { pageClient } from '#lib/ui/client.ts';
	import PathText from '#lib/ui/PathText.svelte';

	let {
		id,
		version,
		onpick,
		onclose
	}: {
		id: ReportId;
		version: RevisionNumber;
		onpick: (file: FileMatch) => void;
		onclose: () => void;
	} = $props();
	let dialog: HTMLDialogElement | undefined = $state();
	let input: HTMLInputElement | undefined = $state();
	let name = $state('');
	let results = $state.raw<FileMatch[]>([]);
	let active = $state(0);
	let waiting = $state(true);
	let problem = $state('');

	$effect(() => {
		dialog?.showModal();
		input?.focus();
	});

	$effect(() => {
		const term = name;
		const report = id;
		const seen = version;
		let live = true;
		waiting = true;
		problem = '';
		active = 0;
		results = [];
		const timer = setTimeout(
			() => {
				void pageClient()
					.searchFiles(report, seen, term)
					.then((found) => {
						if (!live) return;
						waiting = false;
						if (found.ok) results = found.value;
						else problem = describeApiError(found.error);
					});
			},
			term === '' ? 0 : 80
		);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	});

	function choose(index: number): void {
		const match = results[index];
		if (match === undefined) return;
		dialog?.close();
		onpick(match);
	}

	function key(event: KeyboardEvent): void {
		if (event.isComposing) return;
		if (event.key === 'Enter') {
			event.preventDefault();
			choose(active);
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			active = Math.max(
				0,
				Math.min(results.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))
			);
			document.getElementById(`file-match-${active}`)?.scrollIntoView({ block: 'nearest' });
		}
	}
</script>

<dialog bind:this={dialog} aria-labelledby="open-file-heading" oncancel={onclose}>
	<header>
		<h2 id="open-file-heading">Open a file</h2>
		<button type="button" onclick={onclose}>Cancel</button>
	</header>
	<label for="file-name">File name or path</label>
	<input
		id="file-name"
		bind:this={input}
		bind:value={name}
		autocomplete="off"
		maxlength={FILE_QUERY_LENGTH}
		role="combobox"
		aria-autocomplete="list"
		aria-expanded={results.length > 0}
		aria-controls="file-matches"
		aria-activedescendant={results.length > 0 ? `file-match-${active}` : undefined}
		onkeydown={key}
	/>
	<div id="file-matches" role="listbox" aria-label="Matching files" hidden={results.length === 0}>
		{#each results as match, i (`${match.side}:${match.path}`)}
			<!-- The combobox input holds keyboard focus and selects the active option. -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div
				role="option"
				tabindex="-1"
				id="file-match-{i}"
				aria-selected={i === active}
				onclick={() => {
					choose(i);
				}}
			>
				<PathText path={match.path} />
				{#if match.side === 'old'}<span>Deleted</span>
				{:else if match.changed}<span>Changed</span>{/if}
			</div>
		{/each}
	</div>
	{#if waiting}<p role="status">Finding files…</p>
	{:else if problem !== ''}<p role="alert">{problem}</p>
	{:else if results.length === 0}<p role="status">No files match. Try a shorter name.</p>{/if}
</dialog>

<style>
	dialog {
		width: min(34rem, calc(100% - 2rem));
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-background);
		color: var(--color-text);
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 40%);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
	}
	h2 {
		margin: 0;
		font-size: 1.125rem;
	}
	label {
		display: block;
		margin-bottom: 0.3rem;
	}
	input {
		width: 100%;
		box-sizing: border-box;
	}
	[role='listbox'] {
		max-height: min(22rem, 45vh);
		overflow: auto;
		margin-top: 0.65rem;
	}
	[role='option'] {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.4rem 0.55rem;
		overflow-wrap: anywhere;
		cursor: pointer;
	}
	[role='option']:hover,
	[aria-selected='true'] {
		background: var(--color-subtle);
	}
	[role='option'] span {
		color: var(--color-muted);
		font-size: 0.8125rem;
	}
</style>
