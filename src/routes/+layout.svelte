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
	import { onNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { parseReportId } from '#lib/core/report-id.tiny.ts';
	import DelveSwitcherPanel from '#lib/ui/DelveSwitcherPanel.svelte';
	import { provideDelveSwitcher } from '#lib/ui/delve-switcher.svelte.ts';
	import { pageReady } from '#lib/ui/early-input.ts';
	import { onMount } from 'svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	const switcher = provideDelveSwitcher();

	/** The Delve the page is of, when it is a Delve's page: there the header offers the others. */
	const delve = $derived.by(() => {
		if (page.route.id !== '/diffs/[id]') return undefined;
		const id = parseReportId(page.params.id ?? '');
		return id.ok ? id.value : undefined;
	});

	// A link in the panel was followed: the panel is put away before the next page is drawn.
	onNavigate(() => {
		switcher.open = false;
	});

	// Runs after the page's own, so its key handlers are in place for the keys kept until now.
	onMount(pageReady);
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<header>
	<a href={resolve('/')} class="product">diff delver</a>
	<nav aria-label="Your Delves">
		<a href={resolve('/')} aria-current={page.route.id === '/' ? 'page' : undefined}>
			Your Delves
		</a>
		{#if delve !== undefined}
			<button
				type="button"
				onclick={() => {
					switcher.open = true;
				}}
			>
				Other Delves <kbd aria-hidden="true">d</kbd>
			</button>
		{/if}
	</nav>
</header>

<main>
	<!-- Another Delve gets a page of its own, as when it is opened from the list. -->
	{#key delve}
		{@render children()}
	{/key}
</main>

{#if delve !== undefined}
	<DelveSwitcherPanel {switcher} current={delve} />
{/if}

<style>
	header {
		border-bottom: 1px solid var(--color-border);
		background: var(--color-subtle);
		padding: 0.75rem 1.5rem;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1.5rem;
	}

	nav {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
	}

	/* The header is as tall with the button as without, so no page starts lower than another. */
	nav button {
		margin-block: -0.5rem;
	}

	kbd {
		font-size: 0.75rem;
		border: 1px solid currentColor;
		border-radius: 4px;
		padding: 0 0.3rem;
		font-weight: 400;
		opacity: 0.8;
	}

	nav a[aria-current='page'] {
		color: var(--color-text);
		font-weight: 700;
		text-decoration: none;
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
