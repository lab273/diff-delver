<!--
	Asks before something that cannot be undone, such as deleting a diff: what
	will happen, with Cancel first, so Enter on what has focus never does it by
	accident, and Escape keeps everything as it was.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		open = $bindable(false),
		heading,
		confirm,
		onconfirm,
		children
	}: {
		/** Whether it is shown; closing it, with Cancel or Escape, sets this back. */
		open?: boolean;
		heading: string;
		/** What the button that does it says: "Delete". */
		confirm: string;
		onconfirm: () => void | Promise<void>;
		/** What will happen, in a sentence or two. */
		children: Snippet;
	} = $props();

	let dialog: HTMLDialogElement | undefined = $state();

	$effect(() => {
		if (dialog === undefined) return;
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	aria-labelledby="confirm-heading"
	aria-describedby="confirm-what"
	onclose={() => {
		open = false;
	}}
>
	<h2 id="confirm-heading">{heading}</h2>
	<p id="confirm-what">{@render children()}</p>
	<div class="actions">
		<button
			type="button"
			onclick={() => {
				open = false;
			}}
		>
			Cancel
		</button>
		<button type="button" class="danger" onclick={onconfirm}>{confirm}</button>
	</div>
</dialog>

<style>
	dialog {
		max-width: 30rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-background);
		color: var(--color-text);
		padding: 1rem 1.25rem;
	}

	dialog::backdrop {
		background: rgb(0 0 0 / 40%);
	}

	h2 {
		font-size: 1.125rem;
		margin: 0 0 0.5rem;
	}

	.actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 1rem;
	}
</style>
