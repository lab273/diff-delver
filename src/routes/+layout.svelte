<script lang="ts">
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
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
