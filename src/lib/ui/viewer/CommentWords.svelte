<!--
	A comment's words as the reviewer wrote them, drawn as text and never as
	markup, line breaks and tabs kept, with each character that cannot be seen
	written as its escape and marked, as in code and in paths
	(`core/review/comment-words.ts`).
-->
<script lang="ts">
	import { commentLines } from '#lib/core/review/comment-words.ts';

	let { words }: { words: string } = $props();

	const lines = $derived(commentLines(words));
</script>

<p class="words">
	{#each lines as line, l (l)}{#if l > 0}<br
			/>{/if}{#each line as piece, i (i)}{#if piece.kind === 'text'}{piece.text}{:else}<span
					class="escape"
					title="A character that is not seen: {piece.shown}"
				>
					{piece.shown}
				</span>{/if}{/each}{/each}
</p>

<style>
	.words {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		tab-size: 4;
	}

	.escape {
		border: 1px solid var(--color-border);
		border-radius: 3px;
		padding: 0 1px;
		color: var(--color-muted);
		font-family: var(--font-code);
		font-size: 0.875em;
	}
</style>
