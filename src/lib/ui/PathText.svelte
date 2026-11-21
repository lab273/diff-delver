<!--
	A file's path as a person is shown it (`shown-path.tiny.ts`): as text, with
	each character that cannot be seen, or turns text round, written as its
	escape and marked as code's are, so a name never reads as something else;
	and a search's matches on it marked.
-->
<script lang="ts">
	import type { EscapedPath } from '#lib/core/path-bytes.ts';
	import { markedRuns, withMarks, type Mark } from '#lib/core/search/marks.ts';
	import { pathPieces, type PathPiece } from '#lib/core/shown-path.tiny.ts';

	let { path, marks = [] }: { path: EscapedPath; marks?: readonly Mark[] } = $props();

	const SHAPE = {
		size: (piece: PathPiece) => (piece.kind === 'text' ? piece.text.length : piece.shown.length),
		cut: (piece: PathPiece, from: number, to: number): PathPiece | undefined =>
			piece.kind === 'text' ? { kind: 'text', text: piece.text.slice(from, to) } : undefined
	};

	const runs = $derived(markedRuns(withMarks(pathPieces(path), marks, SHAPE)));
</script>

{#snippet drawn(piece: PathPiece)}{#if piece.kind === 'text'}{piece.text}{:else}<span
			class="escape"
			title="A character that is not seen: {piece.shown}"
		>
			{piece.shown}
		</span>{/if}{/snippet}

{#each runs as { pieces, mark }, i (i)}{#if mark === undefined}{#each pieces as piece, p (p)}{@render drawn(
				piece
			)}{/each}{:else}<mark class="match" class:current={mark === 'current'}>
			{#each pieces as piece, p (p)}{@render drawn(piece)}{/each}
		</mark>{/if}{/each}

<style>
	.escape {
		border: 1px solid var(--color-border);
		border-radius: 3px;
		padding: 0 1px;
		color: var(--color-muted);
	}
</style>
