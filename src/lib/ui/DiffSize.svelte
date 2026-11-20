<!--
	A diff's or a file's size as GitHub shows it: lines added in green with a +,
	lines removed in red with a −. The signs and the words read without colour.
-->
<script lang="ts">
	import type { LineCount } from '#lib/core/line-count.tiny.ts';

	let { added, removed }: { added: LineCount; removed: LineCount } = $props();
</script>

<span class="size">
	<span class="added">+{added}<span class="visually-hidden"> added</span></span>
	<span class="removed">−{removed}<span class="visually-hidden"> removed</span></span>
</span>

<style>
	.size {
		font-family: var(--font-code);
		font-size: 0.8125rem;
		white-space: nowrap;
	}

	.added {
		color: var(--color-added);
	}

	.removed {
		color: var(--color-removed);
		margin-left: 0.25rem;
	}
</style>
