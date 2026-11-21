<!--
	A file's path as a person is shown it (`shown-path.tiny.ts`): as text, with
	each character that cannot be seen, or turns text round, written as its
	escape and marked as code's are, so a name never reads as something else.
-->
<script lang="ts">
	import type { EscapedPath } from '#lib/core/path-bytes.ts';
	import { pathPieces } from '#lib/core/shown-path.tiny.ts';

	let { path }: { path: EscapedPath } = $props();
</script>

{#each pathPieces(path) as piece, i (i)}{#if piece.kind === 'text'}{piece.text}{:else}<span
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
	}
</style>
