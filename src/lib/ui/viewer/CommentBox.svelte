<!--
	The box a comment is written in, or a saved one's words are changed in:
	under its lines when they are on the page (`lines`), in place of the saved
	comment being changed (`comment`, or `listed` in the list of comments), or
	in that list when nothing else on the page draws it (`waiting`), with the
	same words wherever it is, since the page keeps them (`comments.svelte.ts`).

	Nothing typed is ever thrown away by anything but Discard: a save that is
	refused keeps the words and says why, and when the Delve has a newer version
	than the page shows, offers the way to it. A new comment whose lines are in
	a version no longer shown waits here until the reviewer chooses lines of the
	version shown, and moves there with its words.
-->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
	import { MAX_COMMENT_LENGTH, describeCommentLines } from '#lib/core/review/draft-comment.ts';
	import { shownPath } from '#lib/core/shown-path.tiny.ts';
	import PathText from '#lib/ui/PathText.svelte';
	import type { Comments, Writing } from './comments.svelte.ts';

	let {
		comments,
		writing,
		version,
		open,
		where,
		showNewer,
		onclosed
	}: {
		comments: Comments;
		writing: Writing;
		/** The version the page shows. */
		version: RevisionNumber;
		/** Whether the Delve is open: a closed one saves nothing. */
		open: boolean;
		/**
		 * Where it is drawn: under its lines in the diff, in place of the saved
		 * comment it changes (in the diff, or `listed` in the list of comments),
		 * or waiting in that list because nothing else on the page draws it.
		 */
		where: 'lines' | 'comment' | 'listed' | 'waiting';
		showNewer: () => void;
		/** After it was saved or discarded and has gone: the keyboard needs somewhere to be. */
		onclosed: () => void;
	} = $props();

	let form = $state<HTMLFormElement>();
	let input = $state<HTMLTextAreaElement>();
	const anchor = $derived(writing.place.anchor);
	const lines = $derived(describeCommentLines(anchor));
	/** A saved comment's words are being changed; its lines stay as they are. */
	const editing = $derived(writing.editing !== undefined);
	/** Away from its lines, it names its file too. */
	const docked = $derived(where === 'waiting' || where === 'listed');
	const title = $derived(editing ? 'Editing your comment' : 'New comment');
	/** A new comment whose lines are in a version the page no longer shows. */
	const waiting = $derived(!editing && writing.place.version !== version);
	const behind = $derived(writing.behindOn === version);
	const blocked = $derived(writing.saving || waiting || behind || !open);

	// Drawn somewhere of its own, it tells the list not to draw it as waiting too.
	onMount(() => {
		if (where === 'waiting') return;
		const inList = where === 'listed';
		if (inList) writing.inList += 1;
		else writing.inDiff += 1;
		return () => {
			if (inList) writing.inList -= 1;
			else writing.inDiff -= 1;
		};
	});

	// The reviewer pressed its line: the box takes the keyboard, wherever it is
	// drawn, once for each press. A box drawn again later, as when its file is
	// opened again, takes nothing.
	$effect(() => {
		const asked = writing.focusAsked;
		void tick().then(() => {
			// Answered by the box that is still there once the page has settled: the
			// list draws a new comment for a moment before its lines take it over.
			if (asked === writing.focusGiven || form?.checkVisibility() !== true) return;
			writing.focusGiven = asked;
			input?.focus({ preventScroll: true });
			// The whole box on the screen, its buttons too, not only the field.
			form.scrollIntoView({ block: 'nearest' });
		});
	});

	async function save(): Promise<void> {
		if (blocked) return;
		const outcome = await comments.save(writing, version);
		await tick();
		if (outcome.kind !== 'saved') {
			// Why it was not saved, and what to do, are on the screen with the box.
			form?.scrollIntoView({ block: 'nearest' });
			return;
		}
		onclosed();
	}

	async function discard(): Promise<void> {
		if (writing.saving) return;
		comments.discard(writing);
		await tick();
		onclosed();
	}

	function onKey(event: KeyboardEvent): void {
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			void save();
		} else if (event.key === 'Escape' && !writing.worthKeeping) {
			// Nothing typed: Escape puts the box away. With words in it, only Discard does.
			event.preventDefault();
			void discard();
		}
	}
</script>

<form
	bind:this={form}
	class="box"
	class:docked
	class:inside={where === 'comment' || where === 'listed'}
	data-writing-comment
	aria-busy={writing.saving}
	aria-label="{title} on {docked ? `${shownPath(anchor.path)}, ` : ''}{lines}"
	onsubmit={(event) => {
		event.preventDefault();
		void save();
	}}
>
	<p class="where">
		<strong>{title}</strong>
		{#if docked}<span class="path"><PathText path={anchor.path} /></span>{/if}
		<span>{lines}</span>
		{#if docked && waiting}<span>Version {writing.place.version}</span>{/if}
	</p>
	{#if waiting}
		<p class="note">
			These lines are in version {writing.place.version}, and this page now shows version {version}.
			To keep what you wrote, press the number of a line here, or press <kbd>c</kbd> on one: it moves
			there with your words.
		</p>
	{:else if where === 'waiting'}
		<p class="note">
			{editing ? 'The comment it changes is' : 'Its lines are'} not on the page now, so it waits here.
			You can still save it.
		</p>
	{/if}
	<label>
		<span class="label">Comment</span>
		<textarea
			rows="3"
			maxlength={MAX_COMMENT_LENGTH}
			bind:this={input}
			bind:value={writing.body}
			readonly={writing.saving}
			onkeydown={onKey}></textarea>
	</label>
	<!-- Why a save was refused, until the page shows the version that refusal was about no more. -->
	{#if writing.problem !== '' && (writing.behindOn === undefined || behind)}
		<p class="problem" role="alert">{writing.problem}</p>
	{/if}
	{#if !open}
		<p class="note">This Delve is closed, so nothing can be saved. Reopen it to save this.</p>
	{/if}
	<div class="actions">
		<button type="submit" class="primary" aria-disabled={blocked}>
			{writing.saving ? 'Saving…' : editing ? 'Save changes' : 'Save comment'}
		</button>
		{#if behind}
			<button type="button" onclick={showNewer}>Show the new version</button>
		{/if}
		<button type="button" aria-disabled={writing.saving} onclick={discard}>
			{editing ? 'Cancel' : 'Discard'}
		</button>
		{#if !editing}<span class="private">A private draft: only you see it.</span>{/if}
	</div>
</form>

<style>
	.box {
		display: grid;
		gap: 0.4rem;
		max-width: 46rem;
		margin: 0.5rem 0.75rem;
		scroll-margin-block: 4rem 0.75rem;
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--color-accent);
		border-radius: 6px;
		background: var(--color-background);
		font-family: var(--font-body);
		font-size: 0.875rem;
		line-height: 1.5;
	}

	.box.docked {
		margin-inline: 0;
	}

	/* In place of the comment it changes, whose frame it takes. */
	.box.inside {
		margin: 0;
		padding: 0;
		border: 0;
		max-width: none;
	}

	p {
		margin: 0;
	}

	.where {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.6rem;
		color: var(--color-muted);
	}

	.where strong {
		color: var(--color-text);
	}

	.path {
		font-family: var(--font-code);
		font-size: 0.8125rem;
		overflow-wrap: anywhere;
	}

	.note {
		color: var(--color-muted);
	}

	label {
		display: grid;
		gap: 0.2rem;
	}

	.label {
		font-weight: 700;
	}

	textarea {
		color: inherit;
		background: var(--color-background);
		border: 1px solid var(--color-border);
		border-radius: 0.25rem;
		padding: 0.35rem 0.5rem;
		resize: vertical;
	}

	.problem {
		color: var(--color-removed);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}

	.primary {
		background: var(--color-primary-button);
		border-color: var(--color-primary-button);
		color: var(--color-on-primary-button);
	}

	.primary:hover {
		background: var(--color-primary-button-hover);
	}

	.private {
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	kbd {
		border: 1px solid var(--color-border);
		border-bottom-width: 2px;
		border-radius: 4px;
		padding: 0 0.3rem;
		font-size: 0.8125rem;
		background: var(--color-subtle);
	}
</style>
