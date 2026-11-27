<!--
	One of the reviewer's questions for the agent (DESIGN 7.2, 8.5), drawn at
	what it is about: under the last of its lines, at the top of its file, or
	under its section's summary. It says what it is about and where it is,
	"Waiting for the agent", "The agent has it" or "Answered", and then each of
	the agent's answers, marked as the agent's and rendered through the
	sanitiser as all agent text is, with the code it pointed at as excerpts
	the daemon read from the snapshot.

	While no agent is connected, a question still waiting says so and offers
	"Copy as prompt": a prompt any agent with diff delver's tools can act on.
	A question no agent has answered can be cancelled; an answered one about
	lines can be promoted into the review, as a comment of the reviewer's own.
-->
<script lang="ts">
	import type { AgentRequestView } from '#lib/api/schemas.ts';
	import { requestStatusWords, isOpenRequest } from '#lib/core/review/agent-request.ts';
	import { describeCommentLines } from '#lib/core/review/draft-comment.ts';
	import { shownPath } from '#lib/core/shown-path.tiny.ts';
	import CopyText from '#lib/ui/CopyText.svelte';
	import VisibleText from '#lib/ui/VisibleText.svelte';
	import AgentMarkdown from './AgentMarkdown.svelte';
	import CommentWords from './CommentWords.svelte';
	import { drawLine } from './draw-line.ts';
	import type { Comments } from './comments.svelte.ts';
	import type { Viewer } from './viewer.svelte.ts';

	let {
		request,
		viewer,
		comments,
		act
	}: {
		request: AgentRequestView;
		viewer: Viewer;
		/** The reviewer's comments, read again when a promoted question becomes one. */
		comments: Comments;
		/** Whether it can be cancelled or promoted here: the Delve is open, and this browser may write. */
		act: boolean;
	} = $props();

	const connected = $derived(viewer.agentConnected);
	const status = $derived(requestStatusWords(request.status, connected));

	async function cancel(): Promise<string | undefined> {
		return viewer.changeRequests({ action: 'cancel', request: request.id });
	}

	async function promote(): Promise<string | undefined> {
		const problem = await viewer.changeRequests({ action: 'promote', request: request.id });
		if (problem === undefined) await comments.load();
		return problem;
	}
	let busy = $state(false);
	let problem = $state('');

	async function run(action: () => Promise<string | undefined>): Promise<void> {
		if (busy) return;
		busy = true;
		problem = (await action()) ?? '';
		busy = false;
	}
</script>

<article
	class="request"
	tabindex="-1"
	data-agent-request={request.id}
	aria-label="Question for the agent about {request.about}"
>
	<p class="where">
		<strong>Question for the agent</strong>
		<span>{request.about}</span>
		<span class="status" class:answered={request.status === 'answered'}>{status}</span>
	</p>
	<div class="question"><CommentWords words={request.question} /></div>
	{#each request.answers as answer, a (a)}
		<section class="answer" aria-label="The agent’s answer">
			<p class="from"><strong>From the agent</strong></p>
			<AgentMarkdown markdown={answer.body} />
			{#each answer.excerpts as excerpt, e (e)}
				{@const shown = describeCommentLines({
					side: excerpt.side,
					first: excerpt.first,
					last: excerpt.last
				})}
				<figure class="excerpt">
					<figcaption>
						<VisibleText text={shownPath(excerpt.path)} />, {shown}
					</figcaption>
					<div class="lines">
						{#each excerpt.lines as line, l (l)}
							<div class="line">
								<span class="number">{excerpt.first + l}</span><span
									class="code"
									use:drawLine={{ text: line, changed: false }}
								></span>
							</div>
						{/each}
					</div>
					{#if excerpt.more > 0}
						<p class="more">
							and {excerpt.more === 1 ? '1 more line' : `${String(excerpt.more)} more lines`}
						</p>
					{/if}
				</figure>
			{/each}
		</section>
	{/each}
	{#if request.status === 'waiting' && !connected && request.prompt !== null}
		<p class="alone">No agent connected. Copy this request and paste it into your agent.</p>
		<CopyText
			text={request.prompt}
			label="Copy as prompt"
			copied="Copied. Paste it into your agent: its answer comes back here."
		/>
	{/if}
	{#if problem !== ''}<p class="problem" role="alert">{problem}</p>{/if}
	{#if act && (isOpenRequest(request.status) || (request.promotable && !request.promoted))}
		<p class="actions">
			{#if request.promotable && !request.promoted}
				<button
					type="button"
					disabled={busy}
					aria-label="Promote the question about {request.about} and its answer to your review"
					onclick={() => run(promote)}
				>
					Promote to review
				</button>
			{/if}
			{#if isOpenRequest(request.status)}
				<button
					type="button"
					disabled={busy}
					aria-label="Cancel the question about {request.about}"
					onclick={() => run(cancel)}
				>
					Cancel question
				</button>
			{/if}
		</p>
	{/if}
</article>

<style>
	.request {
		max-width: 46rem;
		margin: 0.5rem 0.75rem;
		padding: 0.4rem 0.75rem;
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-accent);
		border-radius: 6px;
		background: var(--color-background);
		color: var(--color-text);
		font-family: var(--font-body);
		font-size: 0.8125rem;
		line-height: 1.5;
		scroll-margin-top: 4rem;
	}

	p {
		margin: 0;
	}

	.where {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.6rem;
	}

	.status {
		color: var(--color-muted);
	}

	.status.answered {
		color: var(--color-text);
	}

	.question {
		margin-block: 0.2rem;
	}

	.answer {
		margin-top: 0.4rem;
		padding: 0.3rem 0.6rem;
		border: 1px dashed var(--color-border);
		border-radius: 6px;
		background: var(--color-subtle);
	}

	.from {
		color: var(--color-muted);
	}

	.answer :global(.agent-prose) {
		margin-block: 0.2rem 0;
	}

	.excerpt {
		margin: 0.4rem 0 0;
	}

	figcaption {
		color: var(--color-muted);
	}

	.lines {
		margin: 0.2rem 0 0;
		padding: 0.3rem 0.5rem;
		overflow-x: auto;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background: var(--color-background);
		font-family: var(--font-code);
		font-size: 0.75rem;
		line-height: 1.45;
	}

	.line {
		display: flex;
	}

	.code {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		tab-size: 4;
	}

	.code :global(.tab) {
		position: relative;
	}

	.code :global(.tab)::before {
		content: '»';
		position: absolute;
		left: 0;
		color: var(--color-muted);
		opacity: 0.6;
	}

	.code :global(.trailing) {
		background: var(--color-danger-background);
	}

	.lines :global(.escape) {
		border: 1px solid var(--color-border);
		border-radius: 3px;
		padding: 0 1px;
		color: var(--color-muted);
	}

	.number {
		flex: none;
		display: inline-block;
		min-width: 2.5em;
		margin-right: 0.75em;
		color: var(--color-muted);
		text-align: right;
		user-select: none;
	}

	.more {
		color: var(--color-muted);
	}

	.alone {
		margin-block: 0.4rem 0.3rem;
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
