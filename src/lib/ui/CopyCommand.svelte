<!--
	A command to run, shown as code with a button that copies it.
-->
<script lang="ts">
	let { command, label }: { command: string; label: string } = $props();
	let status = $state('');

	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(command);
			status = 'Copied. Paste it into a terminal, in your repository.';
		} catch {
			status = 'Could not copy: select the command and copy it yourself.';
		}
	}
</script>

<div class="command">
	<code>{command}</code>
	<button type="button" onclick={copy}>{label}</button>
</div>
<p class="status" role="status">{status}</p>

<style>
	.command {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-subtle);
		padding: 0.5rem 0.5rem 0.5rem 1rem;
	}

	code {
		font-size: 0.9375rem;
	}

	.status {
		min-height: 1.5rem;
		margin: 0.25rem 0 0;
		color: var(--color-muted);
		font-size: 0.875rem;
	}
</style>
