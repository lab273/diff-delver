<script lang="ts">
	import { resolve } from '$app/paths';
	// The bundled fonts, served with the app: no network requests at run time.
	// Regular and bold, upright and italic, for text and for code: with
	// font-synthesis: none (src/app.css) a face that is not here is never faked,
	// so emphasis needs its own face to show.
	import '@fontsource/inter/400.css';
	import '@fontsource/inter/400-italic.css';
	import '@fontsource/inter/700.css';
	import '@fontsource/inter/700-italic.css';
	import '@fontsource/jetbrains-mono/400.css';
	import '@fontsource/jetbrains-mono/400-italic.css';
	import '@fontsource/jetbrains-mono/700.css';
	import '@fontsource/jetbrains-mono/700-italic.css';
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import { pageReady } from '#lib/ui/early-input.ts';
	import { onMount } from 'svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Runs after the page's own, so its key handlers are in place for the keys kept until now.
	onMount(pageReady);
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<header>
	<a href={resolve('/')} class="product">diff delver</a>
</header>

<main>
	{@render children()}
</main>

<style>
	header {
		border-bottom: 1px solid var(--color-border);
		background: var(--color-subtle);
		padding: 0.75rem 1.5rem;
	}

	.product {
		color: var(--color-text);
		font-weight: 700;
		text-decoration: none;
	}

	.product:hover {
		text-decoration: underline;
	}

	main {
		max-width: 56rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}
</style>
