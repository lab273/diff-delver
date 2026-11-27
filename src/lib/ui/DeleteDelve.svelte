<!--
	Deleting a Delve: asks first, saying what deleting it removes and, once
	measured, what it frees on disk and when (DESIGN 9.1), then deletes it and
	says what became of it. The list of Delves and the Storage page both use it,
	so a Delve is deleted in one way. Setting `target` asks about one Delve.
-->
<script lang="ts">
	import { describeApiError } from '#lib/api/client.ts';
	import { describeWhatDeletingFrees } from '#lib/core/disk-usage/disk-words.ts';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import type { DeleteTarget } from '#lib/ui/delete-target.ts';
	import { pageClient } from '#lib/ui/client.ts';

	let {
		target = $bindable(),
		ondeleted,
		onfailed
	}: {
		/** The Delve asked about; setting it asks, and it is cleared once answered. */
		target?: DeleteTarget | undefined;
		/** It was deleted, said in a sentence for the page's status. */
		ondeleted: (status: string) => void | Promise<void>;
		/** It was not, and why. */
		onfailed: (problem: string) => void;
	} = $props();

	async function confirmDelete(): Promise<void> {
		if (target === undefined) return;
		const { id, name } = target;
		const deleted = await pageClient().deleteDiff(id);
		target = undefined;
		if (!deleted.ok) {
			onfailed(describeApiError(deleted.error));
			return;
		}
		await ondeleted(
			deleted.value.problem === null
				? `Deleted ${name}. Its space on disk is freed within an hour.`
				: `Deleted ${name}. ${deleted.value.problem}`
		);
	}
</script>

<ConfirmDialog
	bind:open={
		() => target !== undefined,
		(open) => {
			if (!open) target = undefined;
		}
	}
	heading="Delete {target?.name ?? 'this Delve'}?"
	confirm="Delete"
	onconfirm={confirmDelete}
>
	Deleting this Delve removes its draft comments and reviewed marks. Your repository stays as it is.
	{target?.disk?.deleting ?? describeWhatDeletingFrees(undefined, false)}
</ConfirmDialog>
