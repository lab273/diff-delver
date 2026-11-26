<!--
	The overall review's bar (DESIGN 6.3, the draft's summary), pinned to the
	foot of an open Delve's page. Put away, it shows the first words of what is
	written, or that nothing is, and says when something typed is not saved.
	Open, it is the box the overall review is written in, saved as a comment's
	words are: with Save or Control+Enter, exactly as typed, on the words the
	page read, so another tab's change is never overwritten unseen. Either way
	it counts the draft's comments, and offers the way to finish the review.

	On a closed Delve nothing is saved or finished: the bar shows the saved
	words as text, and what was typed before it was closed with them, and says
	to reopen it.

	What is typed is held by the tab (`comments.svelte.ts`), so nothing is lost
	to an update, a regroup or a look at another Delve. Whether the bar is open
	is the person's setting, the same on every Delve.
-->
<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { ReportId } from '#lib/core/report-id.tiny.ts';
	import {
		MAX_OVERALL_REVIEW_LENGTH,
		describeDraftComments,
		isWritten,
		teaserOf
	} from '#lib/core/review/overall-review.ts';
	import { countOf, formatCount } from '#lib/core/viewer/words.ts';
	import ReviewAccess from '#lib/ui/ReviewAccess.svelte';
	import VisibleText from '#lib/ui/VisibleText.svelte';
	import CommentWords from './CommentWords.svelte';
	import type { Comments } from './comments.svelte.ts';

	let {
		id,
		comments,
		open,
		canReview,
		expanded,
		notesWaiting = 0,
		onexpand,
		onfinish,
		height = $bindable(0)
	}: {
		id: ReportId;
		comments: Comments;
		/** Whether the Delve is open: a closed one saves nothing. */
		open: boolean;
		/** Whether this browser may read and write the draft. */
		canReview: boolean;
		/** Whether the bar is open, with its box. */
		expanded: boolean;
		/** The agent's notes on the version shown that wait, counted apart from the reviewer's own. */
		notesWaiting?: number;
		/** The person opened or put away the bar. */
		onexpand: (expanded: boolean) => void;
		/** The person asked to finish the review: the page takes them to Finish and copy. */
		onfinish: () => void;
		/** How tall the bar is, so the page keeps what has the keyboard clear of it. */
		height?: number;
	} = $props();

	let toggle = $state<HTMLButtonElement>();
	let input = $state<HTMLTextAreaElement>();
	const ids = $props.id();
	const writing = $derived(comments.overallWriting);
	const loaded = $derived(comments.overall !== undefined);
	const teaser = $derived(teaserOf(comments.overall?.body ?? ''));
	const unsaved = $derived(comments.overallUnsaved);
	const savedCount = $derived(comments.commentCount);
	const flagCount = $derived(comments.flagCount);
	const beingWritten = $derived(
		comments.writing.filter((w) => w.editing === undefined && w.worthKeeping).length
	);
	const over = $derived(Math.max(0, comments.overallText.length - MAX_OVERALL_REVIEW_LENGTH));
	const blocked = $derived(writing.saving || !open || over > 0 || !unsaved);

	// Asked to take the keyboard, as by its key: the box takes it once it is
	// drawn, as soon as the draft is read, once for each press. A bar drawn
	// again, as when the reviewer comes back to the Delve, answers nothing asked
	// before it was drawn.
	// On a closed Delve, or in a browser that may not write, there is no box:
	// the request is let go, so the box does not take the keyboard unasked later.
	let given = untrack(() => writing.focusAsked);
	$effect(() => {
		const asked = writing.focusAsked;
		if (asked === given) return;
		if (!open || !canReview) {
			given = asked;
			return;
		}
		if (!expanded || input === undefined) return;
		given = asked;
		input.focus();
	});

	async function save(): Promise<void> {
		if (blocked) return;
		await comments.saveOverall();
	}

	async function putAway(): Promise<void> {
		onexpand(false);
		await tick();
		toggle?.focus();
	}

	function onKey(event: KeyboardEvent): void {
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			void save();
		} else if (event.key === 'Escape' && !unsaved) {
			// Nothing unsaved: Escape puts the bar away. With words not saved, only Discard does.
			event.preventDefault();
			void putAway();
		}
	}
</script>

<section
	class="bar"
	data-overall-review
	class:expanded
	aria-labelledby="{ids}-heading"
	aria-busy={canReview && !loaded && comments.problem === ''}
	bind:offsetHeight={height}
>
	<div class="head">
		<h2 id="{ids}-heading" class="visually-hidden">Overall review</h2>
		<button
			type="button"
			class="toggle"
			aria-expanded={expanded}
			aria-controls="{ids}-body"
			bind:this={toggle}
			onclick={() => {
				onexpand(!expanded);
			}}
		>
			<span class="chevron" aria-hidden="true"></span>
			Overall review
			<kbd aria-hidden="true">v</kbd>
		</button>
		{#if !canReview}
			<span class="teaser muted">Comments are off in this browser</span>
		{:else if !expanded && loaded}
			<span class="teaser" class:muted={teaser === undefined}>
				{#if teaser === undefined}Nothing written yet{:else}<VisibleText text={teaser} />{/if}
			</span>
		{:else}
			<span class="teaser"></span>
		{/if}
		{#if canReview && loaded}
			{#if unsaved}<span class="unsaved">Not saved</span>{/if}
			<span class="count">
				{beingWritten === 0
					? describeDraftComments(savedCount, flagCount)
					: savedCount === 0 && flagCount === 0
						? `${countOf(beingWritten, 'comment', 'comments')} being written`
						: `${describeDraftComments(savedCount, flagCount)}, ${formatCount(beingWritten)} more being written`}
			</span>
			{#if notesWaiting > 0}
				<span class="agent-count">
					{countOf(notesWaiting, 'agent note', 'agent notes')} waiting
				</span>
			{/if}
			{#if open && comments.finishable}
				<button type="button" class="finish" onclick={onfinish}>Finish your review</button>
			{/if}
		{/if}
	</div>
	<div class="body" id="{ids}-body" hidden={!expanded}>
		{#if expanded}
			{#if !canReview}
				<ReviewAccess diff={id} what="comments" />
			{:else if comments.problem !== '' && !loaded}
				<p class="problem" role="alert">{comments.problem}</p>
			{:else if loaded && !open}
				<div class="closed">
					<p class="note">
						This Delve is closed, so its overall review cannot be changed and the review cannot be
						finished. Reopen it, at the top of the page, to go on.
					</p>
					<div class="other">
						{#if isWritten(comments.overall?.body ?? '')}<CommentWords
								words={comments.overall?.body ?? ''}
							/>{:else}<p>Nothing written yet.</p>{/if}
					</div>
					{#if unsaved}
						<p class="note">
							What you typed before it was closed, not saved. It can be saved once the Delve is
							reopened:
						</p>
						<div class="other"><CommentWords words={comments.overallText} /></div>
						<div class="actions">
							<button
								type="button"
								onclick={() => {
									comments.discardOverall();
								}}
							>
								Discard changes
							</button>
						</div>
					{/if}
				</div>
			{:else if loaded}
				<form
					aria-busy={writing.saving}
					onsubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<label for="{ids}-words">
						Your overall review of the change: what you think of it as a whole. It comes first in
						the review you finish.
					</label>
					<!-- No limit on the field itself: it would cut a long paste short without a word. -->
					<textarea
						id="{ids}-words"
						rows="4"
						aria-describedby={over > 0 ? `${ids}-over` : undefined}
						bind:this={input}
						bind:value={() => comments.overallText, (text: string) => (comments.overallText = text)}
						readonly={writing.saving}
						onkeydown={onKey}></textarea>
					{#if over > 0}
						<p class="problem" id="{ids}-over" role="status">
							{over === 1 ? '1 character' : `${formatCount(over)} characters`} too long: an overall review
							holds up to {formatCount(MAX_OVERALL_REVIEW_LENGTH)}. Shorten it to save.
						</p>
					{/if}
					{#if writing.changedElsewhere && writing.base !== undefined}
						<div class="note">
							<p>Its words now, as changed elsewhere. Saving again puts yours in their place:</p>
							<div class="other">
								{#if writing.base.body === ''}<p>Nothing: it was emptied.</p>{:else}<CommentWords
										words={writing.base.body}
									/>{/if}
							</div>
						</div>
					{/if}
					{#if writing.problem !== ''}
						<p class="problem" role="alert">{writing.problem}</p>
					{/if}
					<div class="actions">
						<button type="submit" class="primary" aria-disabled={blocked}>
							{writing.saving ? 'Saving…' : 'Save overall review'}
						</button>
						{#if unsaved}
							<button
								type="button"
								aria-disabled={writing.saving}
								onclick={() => {
									comments.discardOverall();
								}}
							>
								Discard changes
							</button>
						{/if}
						<span class="private">A private draft: only you see it.</span>
					</div>
				</form>
			{/if}
		{/if}
	</div>
</section>

<style>
	/* A card held just above the foot of the window, or of the bookmarks under it on a narrow one. */
	.bar {
		position: sticky;
		bottom: calc(var(--dock-height, 0px) + 0.5rem);
		z-index: 2;
		margin-top: 1rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-background);
		box-shadow: 0 2px 10px rgb(0 0 0 / 0.14);
		font-size: 0.875rem;
		line-height: 1.5;
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
		padding: 0.4rem 0.75rem;
	}

	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-weight: 700;
	}

	/* Points up to open the bar, which grows upwards, and down to put it away. */
	.chevron {
		width: 0.4rem;
		height: 0.4rem;
		margin: 0.2rem 0.15rem 0;
		border: solid currentColor;
		border-width: 0 1.5px 1.5px 0;
		transform: rotate(-135deg);
	}

	[aria-expanded='true'] .chevron {
		margin-top: -0.2rem;
		transform: rotate(45deg);
	}

	.teaser {
		flex: 1 1 12rem;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.muted,
	.count,
	.agent-count,
	.private,
	.note {
		color: var(--color-muted);
	}

	.unsaved {
		font-weight: 700;
		color: var(--color-accent);
	}

	.body {
		max-height: 45vh;
		overflow-y: auto;
		padding: 0 0.75rem 0.6rem;
	}

	form,
	.closed {
		display: grid;
		gap: 0.4rem;
		max-width: 60rem;
	}

	p {
		margin: 0;
	}

	textarea {
		color: inherit;
		background: var(--color-background);
		border: 1px solid var(--color-border);
		border-radius: 0.25rem;
		padding: 0.35rem 0.5rem;
		resize: vertical;
		font: inherit;
	}

	.problem {
		color: var(--color-removed);
	}

	.other {
		margin-top: 0.2rem;
		padding-left: 0.6rem;
		border-left: 3px solid var(--color-border);
		color: var(--color-text);
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
		font-size: 0.8125rem;
	}

	kbd {
		border: 1px solid var(--color-border);
		border-bottom-width: 2px;
		border-radius: 4px;
		padding: 0 0.3rem;
		font-size: 0.75rem;
		font-weight: 400;
		background: var(--color-subtle);
	}
</style>
