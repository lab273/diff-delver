<script lang="ts">
	import type { DraftCommentView } from '#lib/api/schemas.ts';
	import type { ReportId } from '#lib/core/report-id.tiny.ts';
	import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
	import PathText from '#lib/ui/PathText.svelte';
	import { describeApiError } from '#lib/api/client.ts';
	import { pageClient } from '#lib/ui/client.ts';

	let {
		id,
		version,
		changes
	}: {
		id: ReportId;
		version: RevisionNumber;
		changes: number;
	} = $props();

	let open = $state<boolean>(false);
	const panelId = $props.id();
	let comments = $state<DraftCommentView[]>();
	let problem = $state('');
	let loading = $state(false);

	$effect(() => {
		if (!open) return;
		const report = id;
		const saved = changes;
		let current = true;
		loading = true;
		problem = '';
		void pageClient()
			.draftComments(report)
			.then((result) => {
				if (!current || changes !== saved || id !== report) return;
				loading = false;
				if (result.ok) comments = result.value;
				else problem = describeApiError(result.error);
			});
		return () => {
			current = false;
		};
	});
</script>

<div class="drafts">
	<button type="button" aria-expanded={open} aria-controls={panelId} onclick={() => (open = !open)}>
		Draft comments
	</button>
	<div id={panelId} aria-busy={open && loading} hidden={!open}>
		{#if loading}
			<p role="status">Loading draft comments…</p>
		{:else if problem !== ''}
			<p role="alert">{problem} Close and reopen Draft comments to try again.</p>
		{:else if comments?.length === 0}
			<p>To write a draft comment, open a file and choose Comment on lines.</p>
		{:else if comments !== undefined}
			<ul>
				{#each comments as { id: key, version: original, anchor, body } (key)}
					<li>
						<strong><PathText path={anchor.path} /></strong>
						<span>
							· {anchor.side === 'old' ? 'Before' : 'After'},
							{anchor.first === anchor.last
								? `line ${String(anchor.first)}`
								: `lines ${String(anchor.first)}–${String(anchor.last)}`}
							· {original < version ? 'Earlier version' : 'Version'}
							{original}
						</span>
						<p class="comment">{body}</p>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>

<style>
	.drafts {
		margin-block: 0.75rem;
	}
	ul {
		padding-inline-start: 1.5rem;
	}
	p {
		margin-block: 0.4rem;
	}
	.comment {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
