<!--
	Says, in place, when the daemon answering this page now runs another version
	than the one that served it, as after diff delver was updated and replaced
	the old daemon at the same address (`stable-port.ts`). The page's scripts are
	the old version's, so it offers to reload; reloading asks first, as leaving
	does, when words typed are not saved (`kept-comments.ts`). It asks when the
	person comes back to the page and now and then, never when the page opens.
-->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { CodeVersion } from '#lib/core/code-version.tiny.ts';
	import {
		describeReplacedForPage,
		describeRestartedForPage
	} from '#lib/core/cli/replaced-daemon.ts';
	import Notice from './Notice.svelte';
	import { pageClient } from './client.ts';
	import { hasAnyUnsavedWords } from './viewer/kept-comments.ts';

	/** How often the page asks, besides when the person comes back to it. */
	const ASK_EVERY_MS = 60_000;

	let { servedBy }: { servedBy: CodeVersion | undefined } = $props();

	// The version the page's scripts came with: the first one it was given.
	const mine = untrack(() => servedBy);
	let running = $state<CodeVersion>();
	// A refusal: a daemon that does not let this page in, as after a restart for a page let in by an agent's link.
	let refused = $state(false);

	onMount(() => {
		if (mine === undefined) return;
		const client = pageClient();
		let asking = false;
		const ask = async (): Promise<void> => {
			if (asking || running !== undefined || refused) return;
			asking = true;
			const info = await client.daemonInfo();
			asking = false;
			if (info.ok && info.value.version !== mine) running = info.value.version;
			else if (
				!info.ok &&
				info.error.kind === 'refused' &&
				info.error.status === 403 &&
				info.error.reason === 'Refused'
			)
				refused = true;
		};
		const cameBack = (): void => {
			if (document.visibilityState === 'visible') void ask();
		};
		document.addEventListener('visibilitychange', cameBack);
		window.addEventListener('focus', cameBack);
		const timer = setInterval(() => void ask(), ASK_EVERY_MS);
		return () => {
			document.removeEventListener('visibilitychange', cameBack);
			window.removeEventListener('focus', cameBack);
			clearInterval(timer);
		};
	});
</script>

{#if running !== undefined || refused}
	<Notice heading={refused ? 'diff delver has restarted' : 'diff delver has been updated'}>
		<p>
			{running !== undefined
				? describeReplacedForPage(running, hasAnyUnsavedWords())
				: describeRestartedForPage(hasAnyUnsavedWords())}
		</p>
		{#snippet actions()}
			<button
				type="button"
				onclick={() => {
					location.reload();
				}}
			>
				Reload the page
			</button>
		{/snippet}
	</Notice>
{/if}
