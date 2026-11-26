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
	import { describeBuild } from '#lib/core/build-identity.ts';
	import { parseReportId } from '#lib/core/report-id.tiny.ts';
	import DaemonReplaced from '#lib/ui/DaemonReplaced.svelte';
	import DelveSwitcherPanel from '#lib/ui/DelveSwitcherPanel.svelte';
	import { provideDelveSwitcher } from '#lib/ui/delve-switcher.svelte.ts';
	import { pageReady } from '#lib/ui/early-input.ts';
	import { onMount } from 'svelte';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();

	const switcher = provideDelveSwitcher();

	/** Which build is running, by the daemon's clock, so it reads the same on every run of a journey. */
	const build = $derived(describeBuild(data.build, data.now));

	/** The Delve the page is of, when it is a Delve's page: there the panel that opens another is drawn. */
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
	<nav aria-label="Pages">
		<a href={resolve('/')} aria-current={page.route.id === '/' ? 'page' : undefined}>
			Your Delves
		</a>
	</nav>
	{#if build !== undefined}
		<!-- Read out as shown, the short commit; the full one and the exact date are its title. -->
		<p class="build" title={build.full}>
			<span class="visually-hidden">Build:</span>
			{build.named}{#if build.ago !== undefined}<span class="ago">{` · ${build.ago}`}</span>{/if}
		</p>
	{/if}
</header>

<main>
	<DaemonReplaced servedBy={data.daemonVersion} />
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

	/*
	 * Quiet, at the right end, and never on a line of its own: how long ago goes
	 * first as the window narrows, then the whole of it.
	 */
	.build {
		margin: 0 0 0 auto;
		color: var(--color-muted);
		font-size: 0.8125rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	@media (max-width: 44rem) {
		.ago {
			display: none;
		}
	}

	@media (max-width: 30rem) {
		.build {
			display: none;
		}
	}

	main {
		max-width: 56rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}
</style>
