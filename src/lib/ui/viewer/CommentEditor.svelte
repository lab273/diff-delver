<script lang="ts">
	import { tick } from 'svelte';
	import type { ReportId } from '#lib/core/report-id.tiny.ts';
	import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
	import { MAX_COMMENT_LENGTH } from '#lib/core/review/draft-comment.ts';
	import PathText from '#lib/ui/PathText.svelte';
	import type { CommentDraft } from './draft-comment.svelte.ts';

	let {
		draft,
		id,
		version,
		open,
		showNewer
	}: {
		draft: CommentDraft;
		id: ReportId;
		version: RevisionNumber;
		open: boolean;
		showNewer: () => void;
	} = $props();

	let input = $state<HTMLTextAreaElement>();
	let status = $state<HTMLParagraphElement>();
	const stale = $derived(draft.location !== undefined && draft.location.version !== version);

	$effect(() => {
		const location = draft.location;
		if (location !== undefined) {
			void tick().then(() => {
				if (draft.location === location) input?.focus();
			});
		}
	});

	async function save(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!open) return;
		await draft.save(id, version);
		await tick();
		if (draft.saved) status?.focus();
	}
</script>

{#if draft.location !== undefined}
	{@const { anchor, version: original } = draft.location}
	<form onsubmit={save} aria-busy={draft.saving} aria-label="Unsaved comment">
		<p>
			<strong>Unsaved comment</strong>
			· <PathText path={anchor.path} />
			· {anchor.side === 'old' ? 'Before' : 'After'},
			{anchor.first === anchor.last
				? `line ${String(anchor.first)}`
				: `lines ${String(anchor.first)}–${String(anchor.last)}`}
			· Version {original}
		</p>
		{#if stale}
			<p>
				These lines are from an earlier version. Choose new lines to save your text on this version.
			</p>
		{/if}
		{#if draft.replacing}
			<p>Open a file and choose Comment on lines, then select a range to use with this text.</p>
		{/if}
		<label>
			Comment
			<textarea
				rows="3"
				maxlength={MAX_COMMENT_LENGTH}
				bind:this={input}
				bind:value={draft.body}
				readonly={draft.saving}></textarea>
		</label>
		{#if draft.problem !== '' && !(stale && draft.behind)}<p role="alert">{draft.problem}</p>{/if}
		<div class="actions">
			<button
				type="submit"
				aria-disabled={draft.saving || draft.behind || stale || draft.replacing || !open}
			>
				{draft.saving ? 'Saving…' : 'Save draft comment'}
			</button>
			{#if draft.behind && !stale}
				<button type="button" onclick={showNewer}>Show newer version</button>
			{:else if open}
				<button
					type="button"
					aria-disabled={draft.saving}
					onclick={() => {
						if (!draft.saving) draft.replacing = !draft.replacing;
					}}
				>
					{draft.replacing ? 'Keep these lines' : 'Choose new lines'}
				</button>
			{/if}
			<button
				type="button"
				aria-disabled={draft.saving}
				onclick={() => {
					draft.discard();
				}}
			>
				Discard unsaved comment
			</button>
		</div>
	</form>
{:else if draft.saved}
	<p role="status" tabindex="-1" bind:this={status}>Draft comment saved.</p>
{/if}

<style>
	form {
		display: grid;
		gap: 0.5rem;
		margin-block: 0.75rem;
		padding: 0.85rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
	}
	p {
		margin: 0;
	}
	label {
		display: grid;
		gap: 0.35rem;
		max-width: 40rem;
	}
	textarea {
		font: inherit;
		color: inherit;
		background: var(--color-background);
		border: 1px solid var(--color-border);
		border-radius: 0.25rem;
		padding: 0.35rem;
		resize: vertical;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
</style>
