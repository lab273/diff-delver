<!--
	A thread of an earlier review (DESIGN 6.3), drawn under the last of its
	lines in the version shown, or, when its lines are gone, in the list above
	the diff with the code it was on. It says where it came from and how it
	stands, in the words of DESIGN 8.5 ("Open", "Code changed since",
	"Resolved"), then each message with the review it was written in. It is
	drawn apart from the draft's own comments: a quieter frame, with its
	status first.

	While the Delve is open, a browser that may write the draft replies to it,
	resolves it or opens it again. Both are part of the draft: the reply is a
	comment of the draft, shown here with Edit and Delete, and what the draft
	does to it says so, with the way to take that back.
-->
<script lang="ts">
	import type { EarlierThreadView } from '#lib/api/schemas.ts';
	import { describeCommentLines } from '#lib/core/review/draft-comment.ts';
	import { describeThreadStart, threadStatusWords } from '#lib/core/review/threads.ts';
	import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
	import { shownPath } from '#lib/core/shown-path.tiny.ts';
	import { tick } from 'svelte';
	import PathText from '#lib/ui/PathText.svelte';
	import VisibleText from '#lib/ui/VisibleText.svelte';
	import CommentWords from './CommentWords.svelte';
	import SavedComment from './SavedComment.svelte';
	import type { Comments } from './comments.svelte.ts';

	let {
		thread,
		comments,
		shown,
		act,
		listed = false,
		ongo,
		showNewer
	}: {
		thread: EarlierThreadView;
		comments: Comments;
		/** The version the page shows. */
		shown: RevisionNumber;
		/** Whether it can be replied to or resolved here: the Delve is open, and this browser may write the draft. */
		act: boolean;
		/** In the list above the diff, where it names its file. */
		listed?: boolean;
		/** From the list: goes to its lines in the diff, when it has some. */
		ongo?: (() => void) | undefined;
		showNewer: () => void;
	} = $props();

	let article = $state<HTMLElement>();
	let input = $state<HTMLTextAreaElement>();
	let busy = $state(false);
	let problem = $state('');
	const inputId = $props.id();

	const start = $derived(describeThreadStart(thread));
	const first = $derived(thread.messages[0]);
	/** Its lines in words, as they are in the version shown, or as they were. */
	const lines = $derived(
		thread.at !== null
			? describeCommentLines(thread.at)
			: first === undefined
				? ''
				: `${describeCommentLines(first.anchor)} in version ${String(first.version)}`
	);
	const path = $derived(thread.at?.path ?? first?.anchor.path);
	const name = $derived(
		`the ${start.toLowerCase()} on ${listed && path !== undefined ? `${shownPath(path)}, ` : ''}${lines}`
	);
	const reply = $derived(comments.replyTo(thread.id));
	const typing = $derived(comments.replying.get(thread.id));
	const resolution = $derived(comments.resolutionOf(thread.id));
	/** How it stands, with what the draft does to it. */
	const standing = $derived(
		resolution === true
			? 'Resolved in this review'
			: resolution === false
				? 'Opened again in this review'
				: threadStatusWords(thread.status)
	);

	async function run(action: () => Promise<string | undefined>): Promise<void> {
		if (busy) return;
		busy = true;
		problem = (await action()) ?? '';
		busy = false;
	}

	async function startReply(): Promise<void> {
		if (!comments.replying.has(thread.id)) comments.replying.set(thread.id, '');
		await tick();
		input?.focus();
	}

	async function saveReply(): Promise<void> {
		await run(() => comments.reply(thread.id, shown));
		if (problem === '') {
			await tick();
			article?.focus({ preventScroll: true });
		}
	}

	async function cancelReply(): Promise<void> {
		comments.replying.delete(thread.id);
		problem = '';
		await tick();
		article?.focus({ preventScroll: true });
	}
</script>

<article
	bind:this={article}
	class="thread"
	class:listed
	class:changed={thread.status === 'changed' && resolution === undefined}
	class:resolved={resolution ?? thread.status === 'resolved'}
	tabindex="-1"
	data-thread={listed ? undefined : thread.id}
	data-listed-thread={listed ? thread.id : undefined}
	aria-label="{start}, {standing}, on {listed && path !== undefined
		? `${shownPath(path)}, `
		: ''}{lines}"
>
	<p class="where">
		<strong>{start}</strong>
		<span class="status">{standing}</span>
		{#if listed && path !== undefined}<span class="path"><PathText {path} /></span>{/if}
		<span>{lines}</span>
	</p>
	{#if thread.at === null}
		<p class="gone">Its lines are no longer in this version.</p>
		{#if thread.quoted.length > 0}
			<div class="code" aria-label="The code it was on">
				{#each thread.quoted as line, i (i)}<span class="line">
						<VisibleText text={line} />
					</span>{/each}
			</div>
		{/if}
	{/if}
	{#each thread.messages as message, i (i)}
		{#if i > 0}<p class="from">Reply in review {message.review}</p>{/if}
		{#if message.body !== ''}<CommentWords words={message.body} />{/if}
	{/each}
	{#if reply !== undefined}
		<SavedComment
			{comments}
			comment={reply}
			now={comments.now}
			{shown}
			open={act}
			{showNewer}
			ongone={() => {
				article?.focus({ preventScroll: true });
			}}
		/>
	{:else if typing !== undefined && act}
		<label class="from" for={inputId}>Your reply</label>
		<textarea
			bind:this={input}
			id={inputId}
			rows="3"
			value={typing}
			oninput={(event) => {
				comments.replying.set(thread.id, event.currentTarget.value);
			}}
			onkeydown={(event) => {
				if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
					event.preventDefault();
					void saveReply();
				} else if (event.key === 'Escape' && typing.trim() === '') {
					event.preventDefault();
					void cancelReply();
				}
			}}></textarea>
	{/if}
	{#if problem !== ''}<p class="problem" role="alert">{problem}</p>{/if}
	{#if act || (listed && ongo !== undefined)}
		<p class="actions">
			{#if listed && ongo !== undefined}
				<button type="button" aria-label="Go to the lines of {name}" onclick={ongo}>
					Go to its lines
				</button>
			{/if}
			{#if act}
				{#if reply === undefined && typing !== undefined}
					<button type="button" disabled={busy} onclick={saveReply}>Save reply</button>
					<button type="button" onclick={cancelReply}>
						{typing.trim() === '' ? 'Cancel' : 'Discard'}
					</button>
				{:else if reply === undefined}
					<button type="button" aria-label="Reply to {name}" onclick={startReply}>Reply</button>
				{/if}
				{#if resolution !== undefined}
					<button
						type="button"
						disabled={busy}
						aria-label="{resolution ? 'Keep open' : 'Keep resolved'}: {name}"
						onclick={() => run(() => comments.resolve(thread.id, shown, 'undo'))}
					>
						{resolution ? 'Keep open' : 'Keep resolved'}
					</button>
				{:else if thread.status === 'resolved'}
					<button
						type="button"
						disabled={busy}
						aria-label="Reopen {name}"
						onclick={() => run(() => comments.resolve(thread.id, shown, 'reopen'))}
					>
						Reopen
					</button>
				{:else}
					<button
						type="button"
						disabled={busy}
						aria-label="Resolve {name}"
						onclick={() => run(() => comments.resolve(thread.id, shown, 'resolve'))}
					>
						Resolve
					</button>
				{/if}
			{/if}
		</p>
	{/if}
</article>

<style>
	.thread {
		max-width: 46rem;
		margin: 0.5rem 0.75rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-muted);
		border-radius: 6px;
		background: var(--color-subtle);
		font-family: var(--font-body);
		font-size: 0.875rem;
		line-height: 1.5;
		scroll-margin-top: 4rem;
	}

	.thread.listed {
		margin-inline: 0;
	}

	.thread.changed {
		border-left-color: var(--color-attention-border);
	}

	.thread.resolved {
		border-left-color: var(--color-added);
	}

	p {
		margin: 0;
	}

	.where {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.6rem;
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	.where strong {
		color: var(--color-text);
	}

	.status {
		padding: 0 0.4rem;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		color: var(--color-text);
		background: var(--color-background);
	}

	.path {
		font-family: var(--font-code);
		overflow-wrap: anywhere;
	}

	.from,
	.gone {
		display: block;
		margin-top: 0.3rem;
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	.code {
		margin: 0.2rem 0 0;
		padding: 0.3rem 0.5rem;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background: var(--color-background);
		font-family: var(--font-code);
		font-size: 0.8125rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.code .line {
		display: block;
		min-height: 1lh;
	}

	textarea {
		display: block;
		box-sizing: border-box;
		width: 100%;
		margin-top: 0.2rem;
		font: inherit;
	}

	.thread :global(.words) {
		margin-top: 0.2rem;
	}

	.thread :global(.comment) {
		margin-inline: 0;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.4rem;
	}

	.actions button {
		padding: 0.1rem 0.6rem;
		font-size: 0.8125rem;
	}

	.problem {
		margin-top: 0.3rem;
		color: var(--color-removed);
	}
</style>
