<!--
	Text to copy, shown exactly as it will be pasted, with a button that copies
	it: a command, an entry for a settings file, a sentence. It comes from the
	machine or the repository (folders, a Delve's title), so it is drawn as text
	with what cannot be seen written out (`VisibleText`), line by line, since a
	line break in it is meant; what is copied is the text itself.
-->
<script lang="ts">
	import type { TextToCopy } from '#lib/core/agent-setup/text-to-copy.tiny.ts';
	import VisibleText from '#lib/ui/VisibleText.svelte';

	let {
		text,
		label,
		copied
	}: {
		text: TextToCopy;
		/** The button's words: "Copy the command". */
		label: string;
		/** What is said once it is copied: where to paste it. */
		copied: string;
	} = $props();
	let status = $state('');
	const lines = $derived(text.split('\n'));

	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			status = copied;
		} catch {
			status = 'Could not copy: select the text and copy it yourself.';
		}
	}
</script>

<div class="copy">
	<pre><code
			>{#each lines as line, i (i)}{i > 0 ? '\n' : ''}<VisibleText text={line} />{/each}</code
		></pre>
	<button type="button" onclick={copy}>{label}</button>
</div>
<p class="status" role="status">{status}</p>

<style>
	.copy {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-subtle);
		padding: 0.5rem 0.5rem 0.5rem 0.75rem;
	}

	pre {
		min-width: 0;
		margin: 0;
		padding: 0.25rem 0;
		font-family: var(--font-code);
		font-size: 0.8125rem;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	button {
		flex: none;
	}

	.status {
		margin: 0.25rem 0 0;
		color: var(--color-muted);
		font-size: 0.8125rem;
	}

	/* Nothing said yet: it takes no room, and stays on the page to be said into. */
	.status:empty {
		margin: 0;
	}
</style>
