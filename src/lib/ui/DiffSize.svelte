<!--
	A diff's or a file's size as GitHub shows it: lines added in green with a +,
	lines removed in red with a −, each only when there are some. Given how many
	of them are tests, it shows those apart, after the rest ("+40 −12 tests +20
	−4"), or alone when every line is one ("all tests +20 −4", the word a
	sentence uses too: "…, all in tests"), so the two add up to the whole. The
	signs and the words read without colour.
-->
<script lang="ts">
	import type { LineCount } from '#lib/core/line-count.tiny.ts';
	import { lineCountOf } from '#lib/core/line-count.tiny.ts';
	import type { LineTally } from '#lib/core/reports/diff-size.ts';

	let {
		added,
		removed,
		tests
	}: {
		/** Every line added, tests among them. */
		added: LineCount;
		/** Every line removed, tests among them. */
		removed: LineCount;
		/** Of those, the lines that are tests, when they are to be shown apart. */
		tests?: LineTally;
	} = $props();

	const testAdded = $derived(tests?.added ?? 0);
	const testRemoved = $derived(tests?.removed ?? 0);
	const mainAdded = $derived(lineCountOf(added - testAdded));
	const mainRemoved = $derived(lineCountOf(removed - testRemoved));
	const hasMain = $derived(mainAdded > 0 || mainRemoved > 0);
	const hasTests = $derived(testAdded > 0 || testRemoved > 0);
</script>

<span class="size">
	{#if mainAdded > 0}
		<span class="added">+{mainAdded}<span class="visually-hidden">&#32;added</span></span>
	{/if}
	{#if mainRemoved > 0}
		<span class="removed">−{mainRemoved}<span class="visually-hidden">&#32;removed</span></span>
	{/if}
	{#if hasTests}
		<span class="tests">
			{#if hasMain}
				<span class="label"><span class="visually-hidden">and in&#32;</span>tests</span>
			{:else}
				<span class="label">all tests</span>
			{/if}
			<span class="visually-hidden">:</span>
			{#if testAdded > 0}
				<span class="added">+{testAdded}<span class="visually-hidden">&#32;added</span></span>
			{/if}
			{#if testRemoved > 0}
				<span class="removed">−{testRemoved}<span class="visually-hidden">&#32;removed</span></span>
			{/if}
		</span>
	{/if}
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
	}

	.added + .removed {
		margin-left: 0.25rem;
	}

	.tests {
		margin-left: 0.25rem;
	}

	.tests:first-child {
		margin-left: 0;
	}

	.label {
		color: var(--color-muted);
		font-family: var(--font-body);
	}
</style>
