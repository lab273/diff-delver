<!--
	A message the page explains itself with, in place: what is going on and what
	to do next, with the actions for it.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		tone = 'attention',
		heading,
		headingId,
		children,
		actions
	}: {
		/** `info` for what happened, `attention` for what needs doing, `danger` for what failed. */
		tone?: 'info' | 'attention' | 'danger';
		heading: string;
		/** Given when the page moves focus to the heading, as after an action that replaced the notice. */
		headingId?: string;
		children: Snippet;
		actions?: Snippet;
	} = $props();
</script>

<section class="notice {tone}" aria-label={heading}>
	{#if headingId === undefined}
		<h2>{heading}</h2>
	{:else}
		<h2 id={headingId} tabindex="-1">{heading}</h2>
	{/if}
	{@render children()}
	{#if actions}
		<div class="actions">{@render actions()}</div>
	{/if}
</section>

<style>
	.notice {
		border: 1px solid;
		border-radius: 6px;
		padding: 0.75rem 1rem;
		margin: 1rem 0;
	}

	.attention {
		background: var(--color-attention-background);
		border-color: var(--color-attention-border);
	}

	.info {
		background: var(--color-info-background);
		border-color: var(--color-info-border);
	}

	.danger {
		background: var(--color-danger-background);
		border-color: var(--color-danger-border);
	}

	h2 {
		font-size: 1rem;
		margin: 0 0 0.25rem;
	}

	.notice :global(p) {
		margin: 0.25rem 0;
	}

	.actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
</style>
