<!--
	The keyboard shortcuts, listed: each a faster way to a control the page also
	shows. Escape or Close puts it away and focus goes back where it was.
-->
<script lang="ts">
	import { SHORTCUTS } from './keys.ts';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	let dialog: HTMLDialogElement | undefined = $state();

	$effect(() => {
		if (dialog === undefined) return;
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	aria-labelledby="shortcuts-heading"
	oncancel={() => {
		// Escape: put away at once, not when the close event comes a moment later, so
		// a key pressed straight after works on the page.
		open = false;
	}}
	onclose={() => {
		open = false;
	}}
>
	<h2 id="shortcuts-heading">Keyboard shortcuts</h2>
	<p>
		Each does what a button on the page does. They work anywhere on the page except while you type
		in a field, and act on the file and line you are on: click a line to be on it.
	</p>
	<dl>
		{#each SHORTCUTS as shortcut (shortcut.action)}
			<div>
				<dt>
					{#each [...shortcut.keys, ...(shortcut.chords ?? [])] as key, i (key)}{#if i > 0}<span
								class="or"
							>
								or
							</span>{/if}<kbd>
							{key}
						</kbd>{/each}
				</dt>
				<dd>{shortcut.does}</dd>
			</div>
		{/each}
		<div>
			<dt><kbd>Tab</kbd></dt>
			<dd>Move to the next control, as everywhere</dd>
		</div>
	</dl>
	<div class="actions">
		<button
			type="button"
			onclick={() => {
				open = false;
			}}
		>
			Close
		</button>
	</div>
</dialog>

<style>
	dialog {
		max-width: 34rem;
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
		margin: 0 0 0.5rem;
		font-size: 1.125rem;
	}

	p {
		margin: 0 0 0.75rem;
		color: var(--color-muted);
		font-size: 0.875rem;
	}

	dl {
		margin: 0;
		display: grid;
		gap: 0.35rem;
	}

	dl > div {
		display: grid;
		grid-template-columns: 8.5rem 1fr;
		gap: 0.75rem;
		align-items: baseline;
	}

	dt {
		text-align: right;
	}

	dd {
		margin: 0;
		font-size: 0.875rem;
	}

	kbd {
		border: 1px solid var(--color-border);
		border-bottom-width: 2px;
		border-radius: 4px;
		padding: 0 0.4rem;
		font-size: 0.8125rem;
		background: var(--color-subtle);
	}

	.or {
		margin: 0 0.3rem;
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 1rem;
	}
</style>
