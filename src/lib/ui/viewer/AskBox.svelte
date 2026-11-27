<!--
	The one Ask box (DESIGN 7.2): opened from the menu under lines, or with
	`q` on a line. It asks about the lines, or, chosen in it, their whole file
	or their section, so the reviewer never picks a kind of request first. The
	two ready-made questions ask at once; anything else is typed. It says
	whether an agent is connected, so the reviewer knows the question goes to
	one now or waits to be copied as a prompt.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { MAX_QUESTION_LENGTH, READY_QUESTIONS } from '#lib/core/review/agent-request.ts';
	import { formatCount } from '#lib/core/viewer/words.ts';

	type About = 'lines' | 'file' | 'section';

	let {
		lines,
		section,
		connected,
		onask,
		onclose
	}: {
		/** The lines, in words: "After, lines 3–5". */
		lines: string;
		/** The title of the section the lines are read in, or undefined when they are in none. */
		section: string | undefined;
		connected: boolean;
		/** Asks; what went wrong, in words, or undefined once it is asked. */
		onask: (about: About, question: string) => Promise<string | undefined>;
		onclose: () => void;
	} = $props();

	let about = $state<About>('lines');
	let question = $state('');
	let asking = $state(false);
	let problem = $state('');
	let input = $state<HTMLTextAreaElement>();
	let form = $state<HTMLFormElement>();
	const ids = $props.id();
	const over = $derived(Math.max(0, question.length - MAX_QUESTION_LENGTH));
	const choices = $derived<readonly { value: About; label: string }[]>([
		{ value: 'lines', label: lines },
		{ value: 'file', label: 'The whole file' },
		...(section === undefined
			? []
			: [{ value: 'section' as const, label: `The section “${section}”` }])
	]);

	onMount(() => {
		form?.scrollIntoView({ block: 'nearest' });
		form?.querySelector<HTMLButtonElement>('button[data-ready]')?.focus({ preventScroll: true });
	});

	async function ask(text: string): Promise<void> {
		if (asking) return;
		if (text.trim() === '' || text.length > MAX_QUESTION_LENGTH) {
			problem =
				text.trim() === ''
					? 'Write a question, or choose one of the ready-made ones.'
					: 'Shorten the question to ask it.';
			input?.focus();
			return;
		}
		asking = true;
		problem = (await onask(about, text)) ?? '';
		asking = false;
	}

	function onKey(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onclose();
		}
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form
	class="ask"
	aria-label="Ask the agent"
	data-writing-comment
	bind:this={form}
	onkeydown={onKey}
	onsubmit={(event) => {
		event.preventDefault();
		void ask(question);
	}}
>
	<p class="where"><strong>Ask the agent</strong></p>
	<fieldset>
		<legend>About</legend>
		{#each choices as choice (choice.value)}
			<label class="choice">
				<input type="radio" name="{ids}-about" value={choice.value} bind:group={about} />
				{choice.label}
			</label>
		{/each}
	</fieldset>
	<div class="ready">
		{#each READY_QUESTIONS as ready, r (r)}
			<button type="button" data-ready aria-disabled={asking} onclick={() => ask(ready)}>
				{ready.replace(/\.$/, '')}
			</button>
		{/each}
	</div>
	<label class="own">
		<span class="label">Or ask in your own words</span>
		<textarea
			rows="2"
			aria-describedby={over > 0 ? `${ids}-over` : undefined}
			bind:this={input}
			bind:value={question}
			readonly={asking}></textarea>
	</label>
	{#if over > 0}
		<p class="problem" id="{ids}-over" role="status">
			{over === 1 ? '1 character' : `${formatCount(over)} characters`} too long: a question holds up to
			{formatCount(MAX_QUESTION_LENGTH)}.
		</p>
	{/if}
	{#if problem !== ''}<p class="problem" role="alert">{problem}</p>{/if}
	<p class="note">
		{connected
			? 'Agent connected: it gets your question at once, and its answer appears here.'
			: 'No agent connected: your question waits here, and you can copy it as a prompt for your agent.'}
	</p>
	<div class="actions">
		<button type="submit" class="primary" aria-disabled={asking}>
			{asking ? 'Asking…' : 'Ask'}
		</button>
		<button type="button" onclick={onclose}>Cancel</button>
	</div>
</form>

<style>
	.ask {
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

	p {
		margin: 0;
	}

	fieldset {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 1rem;
		margin: 0;
		padding: 0;
		border: 0;
	}

	legend {
		float: left;
		margin-right: 0.6rem;
		padding: 0;
		font-weight: 700;
	}

	.choice {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}

	.ready,
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}

	.own {
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

	.note {
		color: var(--color-muted);
	}

	.problem {
		color: var(--color-removed);
	}

	.primary {
		background: var(--color-primary-button);
		border-color: var(--color-primary-button);
		color: var(--color-on-primary-button);
	}

	.primary:hover {
		background: var(--color-primary-button-hover);
	}
</style>
