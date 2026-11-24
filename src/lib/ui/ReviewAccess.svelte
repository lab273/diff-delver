<!--
	What a page says, in place, when its browser may read and tick but not
	write the person's own things (comments, deleting a Delve): why, and one
	button that turns them on. Pressing it has diff delver open the same page
	in the person's browser, in a window that may write them; this page then
	notices, when the person comes back to it, that its browser may too, and
	its parent stops showing this.

	The page never sees the address that window opens with (DESIGN 9): it is
	told only whether a browser could be asked.
-->
<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { describeApiError } from '#lib/api/client.ts';
	import type { ReportId } from '#lib/core/report-id.tiny.ts';
	import CopyCommand from '#lib/ui/CopyCommand.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import { pageClient } from '#lib/ui/client.ts';
	import { RUN_COMMAND } from '#lib/ui/run-command.ts';

	let {
		diff,
		what
	}: {
		/** The Delve to open in the new window, or null for the list of Delves. */
		diff: ReportId | null;
		/** What the page would offer here: comments on a Delve, deleting in the list of them. */
		what: 'comments' | 'deleting';
	} = $props();

	const off = $derived(what === 'comments' ? 'Comments are' : 'Deleting is');

	type Asked =
		| { readonly kind: 'not-yet' }
		| { readonly kind: 'asking' }
		| { readonly kind: 'opened' }
		| { readonly kind: 'no-browser' }
		| { readonly kind: 'too-soon' }
		| { readonly kind: 'failed'; readonly message: string };
	let asked = $state<Asked>({ kind: 'not-yet' });

	async function turnOn(): Promise<void> {
		if (asked.kind === 'asking') return;
		asked = { kind: 'asking' };
		const window = await pageClient().openReviewWindow(diff);
		if (!window.ok) asked = { kind: 'failed', message: describeApiError(window.error) };
		else asked = { kind: window.value.outcome };
	}

	// Coming back to this tab, as from the one that just opened: ask again whether
	// this browser may write, so the page turns it on without a reload.
	$effect(() => {
		const again = (): void => {
			if (document.visibilityState === 'visible') void invalidate('app:review-access');
		};
		window.addEventListener('focus', again);
		document.addEventListener('visibilitychange', again);
		return () => {
			window.removeEventListener('focus', again);
			document.removeEventListener('visibilitychange', again);
		};
	});
</script>

<Notice heading="{off} off in this browser">
	<p>
		You came here by a link, such as one a coding agent gave you. A link lets you read and tick.
		Your comments, and deleting a Delve, are yours alone, so diff delver turns them on only in a
		window it opens for you itself.
	</p>
	<div role="status">
		{#if asked.kind === 'opened'}
			<p>
				<strong>A new tab has opened with {what} turned on.</strong> Carry on there, or come back to
				this tab, which turns {what} on too once the new tab has opened.
			</p>
		{:else if asked.kind === 'no-browser'}
			<p>
				<strong>diff delver could not open a browser from where it runs,</strong> as on a machine with
				no screen. Run this in a terminal there, in your repository, and open the address it prints in
				this browser. Then come back to this tab.
			</p>
		{:else if asked.kind === 'too-soon'}
			<p>
				<strong>A window was opened a moment ago.</strong> Look for its tab. If there is none, press the
				button again in a few seconds.
			</p>
		{:else if asked.kind === 'failed'}
			<p><strong>That did not work.</strong> {asked.message}</p>
		{/if}
	</div>
	{#if asked.kind === 'no-browser'}
		<CopyCommand command={`${RUN_COMMAND} --no-open`} label="Copy the command" />
	{/if}
	{#snippet actions()}
		<button type="button" aria-disabled={asked.kind === 'asking'} onclick={turnOn}>
			{asked.kind === 'opened' ? 'Open another tab' : `Turn on ${what} in this browser`}
		</button>
	{/snippet}
</Notice>
