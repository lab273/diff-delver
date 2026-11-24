<!--
	The way to open something new in a repository diff delver knows, with no
	terminal: a link to the choose page for its folder, or, when the folder is no
	longer there, a sentence that says so instead of a link that leads nowhere.
	Another kind of source, such as a pull request, would be offered beside it.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ListedRepository } from '#lib/api/schemas.ts';
	import VisibleText from '#lib/ui/VisibleText.svelte';

	let { repository }: { repository: ListedRepository } = $props();

	const query = $derived(new URLSearchParams({ directory: repository.directory }).toString());
</script>

{#if repository.there}
	<a href={resolve(`/choose?${query}`)}>Choose commits or a branch in {repository.repository}</a>
	{#if repository.sameName}
		<span class="where">(<VisibleText text={repository.directory} />)</span>
	{/if}
{:else}
	<span class="gone">
		Nothing new can be opened in {repository.repository}: its folder,
		<span class="folder"><VisibleText text={repository.directory} /></span>, is no longer there. If
		it was moved, run diff delver in it where it is now.
	</span>
{/if}

<style>
	.where,
	.gone {
		color: var(--color-muted);
	}

	.folder {
		overflow-wrap: anywhere;
	}
</style>
