<!--
	How far the review has got, as a bar with its words beside it: the words
	carry the meaning, the bar only shows it at a glance.
-->
<script lang="ts">
	import type { TallyView } from '#lib/api/schemas.ts';

	let { tally, label, text }: { tally: TallyView; label: string; text: string } = $props();

	const share = $derived(tally.units === 0 ? 0 : tally.reviewed / tally.units);
</script>

<div
	class="bar"
	role="progressbar"
	aria-label={label}
	aria-valuemin={0}
	aria-valuemax={tally.units}
	aria-valuenow={tally.reviewed}
	aria-valuetext={text}
>
	<div class="done" style:width="{(share * 100).toFixed(2)}%"></div>
</div>

<style>
	.bar {
		height: 0.5rem;
		border-radius: 1rem;
		background: var(--color-subtle);
		border: 1px solid var(--color-border);
		overflow: hidden;
	}

	.done {
		height: 100%;
		background: var(--color-added);
	}
</style>
