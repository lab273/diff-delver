<script lang="ts">
	import { tick } from 'svelte';
	import { parseLineNumber, type LineNumber } from '#lib/core/line-number.tiny.ts';
	import type { EscapedPath } from '#lib/core/path-bytes.ts';
	import type { Side } from '#lib/core/side.tiny.ts';
	import { MAX_COMMENT_LENGTH } from '#lib/core/review/draft-comment.ts';
	import { describeApiError } from '#lib/api/client.ts';
	import { pageClient } from '#lib/ui/client.ts';
	import type { Viewer } from './viewer.svelte.ts';

	let {
		viewer,
		path,
		onclose,
		onsaved
	}: {
		viewer: Viewer;
		path: EscapedPath;
		onclose: () => void;
		onsaved: () => void;
	} = $props();

	let start = $state<{ side: Side; line: LineNumber }>();
	let end = $state<number>();
	let body = $state('');
	let problem = $state('');
	let saving = $state(false);
	let input = $state<HTMLTextAreaElement>();

	export async function choose(side: Side, line: LineNumber): Promise<void> {
		if (saving) return;
		start = { side, line };
		end = undefined;
		problem = '';
		await tick();
		input?.focus();
	}

	async function save(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (saving || start === undefined) return;
		const last = parseLineNumber(end ?? start.line);
		if (!last.ok || last.value < start.line) {
			problem = 'Enter a last line at or after the first line.';
			return;
		}
		if (body.trim() === '') {
			problem = 'Write a comment before saving.';
			input?.focus();
			return;
		}
		problem = '';
		saving = true;
		const result = await pageClient().addDraftComment(viewer.id, {
			version: viewer.version,
			anchor: { path, side: start.side, first: start.line, last: last.value },
			body
		});
		saving = false;
		if (!result.ok) {
			problem = describeApiError(result.error);
			return;
		}
		onsaved();
	}
</script>

<div class="editor">
	{#if start === undefined}
		<p>Choose a line number before or after the change.</p>
		<button type="button" onclick={onclose}>Cancel</button>
	{:else}
		<form onsubmit={save} aria-busy={saving}>
			<p>{start.side === 'old' ? 'Before' : 'After'}, line {start.line}</p>
			<label>
				Last line (optional)
				<input
					type="number"
					min={start.line}
					placeholder={String(start.line)}
					bind:value={end}
					readonly={saving}
				/>
			</label>
			<label>
				Comment
				<textarea
					rows="3"
					maxlength={MAX_COMMENT_LENGTH}
					bind:this={input}
					bind:value={body}
					readonly={saving}></textarea>
			</label>
			{#if problem !== ''}<p role="alert">{problem}</p>{/if}
			<div class="actions">
				<button type="submit" aria-disabled={saving}>
					{saving ? 'Saving…' : 'Save draft comment'}
				</button>
				<button
					type="button"
					aria-disabled={saving}
					onclick={() => {
						if (!saving) onclose();
					}}
				>
					Cancel
				</button>
			</div>
		</form>
	{/if}
</div>

<style>
	.editor {
		padding: 0.65rem 0.85rem;
	}
	p {
		margin: 0 0 0.5rem;
	}
	form,
	label {
		display: grid;
		gap: 0.35rem;
	}
	form {
		max-width: 40rem;
	}
	input {
		width: 8rem;
	}
	input,
	textarea {
		font: inherit;
		color: inherit;
		background: var(--color-background);
		border: 1px solid var(--color-border);
		border-radius: 0.25rem;
		padding: 0.35rem;
	}
	textarea {
		resize: vertical;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
	}
</style>
