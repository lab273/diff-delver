<script lang="ts">
	import type { AgentMarkdown } from '#lib/core/agent-markdown.tiny.ts';
	import { renderAgentMarkdown } from './agent-markdown.ts';

	let { markdown, label }: { markdown: AgentMarkdown; label?: string } = $props();
	const html = $derived(renderAgentMarkdown(markdown));
</script>

<div class="agent-prose">
	{#if label !== undefined}
		<p class="label">{label}</p>
	{/if}
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- The renderer escapes raw HTML and discards resource URLs. -->
	{@html html}
</div>

<style>
	.agent-prose {
		max-width: 72ch;
		margin-block: 0.55rem 0.85rem;
		overflow-wrap: anywhere;
	}

	.label {
		color: var(--color-muted);
		font-size: 0.8125rem;
		font-weight: 700;
	}

	.agent-prose > :global(*) {
		margin-block: 0.5em;
	}

	.agent-prose :global(pre) {
		overflow-x: auto;
	}

	.agent-prose :global(blockquote) {
		margin-inline: 0;
		padding-inline-start: 0.75em;
		border-inline-start: 0.2em solid var(--color-border);
	}

	.agent-prose :global(table) {
		display: block;
		overflow-x: auto;
	}
</style>
