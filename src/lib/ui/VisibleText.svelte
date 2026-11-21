<!--
	Text from a repository, such as a branch's name or a commit's subject, as a
	person is shown it (`textPieces` in `hidden-characters.ts`): as text, never
	markup, with each character that cannot be seen, or turns text round,
	written as its escape and marked as a path's are.
-->
<script lang="ts">
	import { textPieces } from '#lib/core/hidden-characters.ts';

	let { text }: { text: string } = $props();

	const pieces = $derived(textPieces(text));
</script>

{#each pieces as piece, i (i)}{#if piece.kind === 'text'}{piece.text}{:else}<span
			class="escape"
			title="A character that is not seen: {piece.shown}"
		>
			{piece.shown}
		</span>{/if}{/each}

<style>
	.escape {
		border: 1px solid var(--color-border);
		border-radius: 3px;
		padding: 0 1px;
		color: var(--color-muted);
		font-family: var(--font-code);
		font-size: 0.875em;
	}
</style>
