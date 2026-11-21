<!--
	Why a tick did not happen, said where it was made, as an alert: "Nothing was
	marked." and why, with what to do; when the diff has a newer version than the
	page shows, the way to it.
-->
<script lang="ts">
	let {
		message,
		behind,
		onshownewer
	}: {
		message: string;
		/** The diff has a newer version than the page shows. */
		behind: boolean;
		onshownewer: () => void;
	} = $props();
</script>

<div class="refused">
	<p class="problem" role="alert">{message}</p>
	{#if behind}
		<button type="button" onclick={onshownewer}>Show the new version</button>
	{/if}
</div>

<style>
	.refused {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0 0.75rem;
	}

	.problem {
		margin: 0;
		padding: 0.5rem 0.75rem;
		font-size: 0.875rem;
		color: var(--color-removed);
	}

	.refused button {
		margin: 0 0.75rem 0.5rem;
	}
</style>
