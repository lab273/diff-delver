<!--
	The agent's notes on the version shown, counted above the diff and apart
	from the reviewer's own comments: how many wait and how many were
	dismissed, whether they are drawn at their lines (the person's setting, and
	`a`), and the way to bring dismissed ones back. Drawn only when the agent
	left notes on this version.
-->
<script lang="ts">
	import { countOf } from '#lib/core/viewer/words.ts';

	let {
		waiting,
		dismissed,
		shown,
		act,
		onshow,
		onrestore
	}: {
		/** Notes neither dismissed nor promoted. */
		waiting: number;
		dismissed: number;
		/** Whether notes are drawn at their lines. */
		shown: boolean;
		/** Whether dismissed notes can be brought back here: the Delve is open, and this browser may write. */
		act: boolean;
		onshow: (shown: boolean) => void;
		/** Brings dismissed notes back; what went wrong, in words, or undefined. */
		onrestore: () => Promise<string | undefined>;
	} = $props();

	let problem = $state('');
	let busy = $state(false);
	let toggle = $state<HTMLButtonElement>();
</script>

<section class="notes" aria-label="Agent notes">
	<p>
		<strong>Agent notes:</strong>
		{waiting === 0 ? 'none waiting' : `${countOf(waiting, 'note', 'notes')} waiting`}{dismissed > 0
			? `, ${String(dismissed)} dismissed`
			: ''}.
		<span class="muted">
			The agent’s pointers, after your own reading; none goes in your review unless you promote it.
		</span>
	</p>
	<p class="actions">
		<button
			type="button"
			id="agent-notes-toggle"
			bind:this={toggle}
			aria-pressed={shown}
			onclick={() => {
				onshow(!shown);
			}}
		>
			Show agent notes <kbd aria-hidden="true">a</kbd>
		</button>
		{#if act && dismissed > 0}
			<button
				type="button"
				disabled={busy}
				onclick={async () => {
					busy = true;
					problem = (await onrestore()) ?? '';
					busy = false;
					// The button goes once nothing is dismissed: the toggle beside it takes the keyboard.
					if (problem === '') toggle?.focus();
				}}
			>
				Bring back dismissed notes
			</button>
		{/if}
	</p>
	{#if problem !== ''}<p class="problem" role="alert">{problem}</p>{/if}
</section>

<style>
	.notes {
		margin-block: 0.75rem;
		font-size: 0.875rem;
	}

	p {
		margin: 0;
		max-width: 46rem;
	}

	.muted {
		color: var(--color-muted);
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

	kbd {
		border: 1px solid var(--color-border);
		border-bottom-width: 2px;
		border-radius: 4px;
		padding: 0 0.3rem;
		font-size: 0.75rem;
		background: var(--color-subtle);
	}
</style>
