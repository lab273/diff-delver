<!--
	One file's part within one group, as the reviewer reads and ticks it: its
	path, how the file changed, its size, where its other parts are, what is new
	in it, and the Reviewed tick; then, while open, what changed about the file
	itself and its lines, fetched when it comes near the screen.
-->
<script lang="ts">
	import type { GroupKeyView, PartLines as PartLinesView } from '#lib/api/schemas.ts';
	import { describeByteSize, countOf, describeTally, formatCount } from '#lib/core/viewer/words.ts';
	import type { EscapedPath } from '#lib/core/path-bytes.ts';
	import { shownPath } from '#lib/core/shown-path.tiny.ts';
	import PathText from '#lib/ui/PathText.svelte';
	import type { PartIndex } from '#lib/core/part-index.tiny.ts';
	import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
	import DiffSize from '#lib/ui/DiffSize.svelte';
	import PartLines from './PartLines.svelte';
	import TickRefused from './TickRefused.svelte';
	import { done, partly, showTally, type PartState, type Viewer } from './viewer.svelte.ts';

	let {
		viewer,
		state,
		previousVersion,
		ontick,
		ongo,
		onshownewer
	}: {
		viewer: Viewer;
		state: PartState;
		previousVersion: RevisionNumber | null;
		ontick: (at: PartIndex, reviewed: boolean) => Promise<void>;
		ongo: (path: EscapedPath, group: GroupKeyView) => void;
		/** Shows the diff's newer version, when a tick was refused for being behind it. */
		onshownewer: () => void;
	} = $props();

	const at = $derived(state.index);
	const part = $derived(state.part);
	const ignored = $derived(part.group.kind === 'ignored');
	const reviewed = $derived(done(part.tally));
	const large = $derived(viewer.isLarge(state));
	const groupName = $derived(viewer.groupOfPart(at)?.name ?? '');
	/** Its path as a person is shown it, in what is read out. */
	const shown = $derived(shownPath(part.path));

	// Its lines are fetched once it is open and near the screen, however it came to
	// be open: by the person, by moving to it, or by unticking it.
	$effect(() => {
		if (state.near && state.open && !large && state.lines.kind === 'waiting') void viewer.load(at);
	});

	function sizesText(sizes: NonNullable<PartLinesView['sizes']>): string {
		if (sizes.old !== null && sizes.new !== null) {
			return `${describeByteSize(sizes.old)} before, ${describeByteSize(sizes.new)} after`;
		}
		if (sizes.new !== null) return describeByteSize(sizes.new);
		if (sizes.old !== null) return describeByteSize(sizes.old);
		return 'its size is not known';
	}

	function capitalised(text: string): string {
		return text.charAt(0).toUpperCase() + text.slice(1);
	}

	/** Watches whether the part is near the screen. */
	function nearScreen(element: HTMLElement) {
		const observer = new IntersectionObserver(
			(entries) => {
				const last = entries.at(-1);
				if (last !== undefined) state.near = last.isIntersecting;
			},
			{ rootMargin: '1500px 0px' }
		);
		observer.observe(element);
		return {
			destroy() {
				observer.disconnect();
			}
		};
	}
</script>

<article
	class="part"
	class:reviewed
	class:ignored
	id="part-{at}"
	aria-labelledby="part-{at}-name"
	style:contain-intrinsic-size="auto {state.open && !large
		? Math.min(part.rows, 2000) * 20 + 60
		: 48}px"
	use:nearScreen
>
	<header>
		<h3>
			<button
				type="button"
				class="toggle"
				id="part-{at}-toggle"
				aria-expanded={state.open}
				aria-controls="part-{at}-body"
				aria-label="{shown}{part.of > 1 ? `, part ${part.position} of ${part.of}` : ''}"
				onclick={() => {
					state.open = !state.open;
					viewer.current = at;
					// Opened by the person: fetch at once rather than wait to be scrolled to.
					if (state.open && !large) void viewer.load(at);
				}}
			>
				<span class="chevron" aria-hidden="true"></span>
				<span class="path" id="part-{at}-name"><PathText path={part.path} /></span>
			</button>
		</h3>
		<span class="change">{part.change}</span>
		{#if part.of > 1}
			<span class="chip" aria-hidden="true">Part {part.position} of {part.of}</span>
		{/if}
		{#each part.others as other, i (i)}
			<a
				class="chip link"
				href="#{viewer.groupWithKey(other)?.anchor ?? ''}"
				aria-label="Also in {viewer.groupWithKey(other)?.name ?? 'another group'}: {shown}"
				onclick={(event) => {
					event.preventDefault();
					ongo(part.path, other);
				}}
			>
				Also in {viewer.groupWithKey(other)?.name ?? 'another group'}
			</a>
		{/each}
		{#if part.tally.fresh > 0 && !ignored}
			<span class="fresh">
				{formatCount(part.tally.fresh)} new<span class="visually-hidden">
					since version {previousVersion}
				</span>
			</span>
		{/if}
		{#each part.ignored as reason, r (r)}
			<span class="reason">
				{reason.kind === 'agent' ? `Agent: ${reason.reason}` : reason.text}
			</span>
		{/each}
		<span class="size"><DiffSize added={part.added} removed={part.removed} /></span>
		{#if ignored}
			<span class="tally">Not counted</span>
		{:else}
			{#if !reviewed}<span class="tally">{describeTally(part.tally)}</span>{/if}
			<label class="tick">
				<input
					type="checkbox"
					aria-label="Reviewed: {shown}{part.of > 1 ? ` in ${groupName}` : ''}"
					checked={reviewed}
					indeterminate={partly(part.tally)}
					aria-describedby={state.busy ? `part-${String(at)}-saving` : undefined}
					onchange={async (event) => {
						const box = event.currentTarget;
						// Never disabled while the tick is saved, so focus stays on it; a press
						// meanwhile is ignored.
						if (state.busy) {
							box.checked = !box.checked;
							return;
						}
						viewer.current = at;
						await ontick(at, box.checked);
						// A tick that was refused leaves the box as the diff has it.
						showTally(box, state.part.tally);
					}}
				/>
				Reviewed
			</label>
			{#if state.busy}<span class="visually-hidden" id="part-{at}-saving">Saving</span>{/if}
		{/if}
	</header>
	{#if state.problem !== ''}
		<div class="refused">
			<TickRefused message={state.problem} behind={state.behind} {onshownewer} />
		</div>
	{/if}
	<div class="body" id="part-{at}-body" hidden={!state.open}>
		{#if state.open}
			{#if part.tally.unmarked > 0}
				<p class="unmarked">
					You had marked {countOf(part.tally.unmarked, 'change', 'changes')} here as reviewed. {part
						.tally.unmarked === 1
						? 'It is'
						: 'They are'} unmarked now because lines close to {part.tally.unmarked === 1
						? 'it'
						: 'them'} changed in this version, so {part.tally.unmarked === 1 ? 'it is' : 'they are'} worth
					reading again.
				</p>
			{/if}
			{#if part.fileUnit !== null && part.added + part.removed > 0}
				<p class="file-change">
					{capitalised(part.fileUnit)}
				</p>
			{/if}
			{#if part.content === 'submodule'}
				<p class="about">
					A submodule: its files belong to another repository, so only the commit it points at
					changed.
				</p>
			{:else if large}
				<p class="about">
					This is a large change: {countOf(part.rows, 'line', 'lines')}. It is not shown until you
					ask, so the page stays quick.
				</p>
				<button
					type="button"
					onclick={() => {
						state.showLarge = true;
						void viewer.load(at);
						// The button goes; focus stays in the part, on its name.
						document.getElementById(`part-${String(at)}-toggle`)?.focus();
					}}
				>
					Show this large change
				</button>
			{:else if state.lines.kind === 'loaded'}
				{@const lines = state.lines}
				{#if lines.sizes !== null}
					<p class="about">
						A binary file, so it is not shown as text:
						{sizesText(lines.sizes)}.
					</p>
				{:else if lines.blocks.length > 0}
					{#if viewer.hasHidden(at)}
						<div class="tools">
							<button
								type="button"
								aria-label="{viewer.wholeShown(at)
									? 'Show only the changes'
									: 'Show the whole file'}: {shown}"
								onclick={() => {
									viewer.current = at;
									void viewer.wholeFile(at);
								}}
							>
								{viewer.wholeShown(at) ? 'Show only the changes' : 'Show the whole file'}
							</button>
						</div>
					{/if}
					<PartLines
						{viewer}
						{at}
						blocks={lines.blocks}
						path={part.path}
						{previousVersion}
						ongo={(group: GroupKeyView) => {
							ongo(part.path, group);
						}}
					/>
				{/if}
			{:else if state.lines.kind === 'failed'}
				<p class="problem" role="alert">{state.lines.message}</p>
				<button
					type="button"
					onclick={() => {
						state.lines = { kind: 'waiting' };
						void viewer.load(at);
						// The button goes while the lines come; focus stays in the part, on its name.
						document.getElementById(`part-${String(at)}-toggle`)?.focus();
					}}
				>
					Try again
				</button>
			{:else}
				<p class="about loading">Loading the lines…</p>
			{/if}
		{/if}
	</div>
</article>

<style>
	.part {
		border: 1px solid var(--color-border);
		border-radius: 6px;
		margin: 0 0 1rem;
		content-visibility: auto;
		scroll-margin-top: 1rem;
		background: var(--color-background);
	}

	header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
		padding: 0.4rem 0.75rem;
		background: var(--color-subtle);
		border-radius: 6px 6px 0 0;
		font-size: 0.875rem;
	}

	.part:has(.body[hidden]) header {
		border-radius: 6px;
	}

	.part:not(:has(.body[hidden])) header {
		border-bottom: 1px solid var(--color-border);
	}

	h3 {
		margin: 0;
		font-size: inherit;
		min-width: 0;
	}

	.toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		border: 0;
		background: none;
		padding: 0.1rem 0.25rem;
		font-weight: 700;
		text-align: left;
	}

	.chevron {
		flex: none;
		width: 0.4rem;
		height: 0.4rem;
		border: solid var(--color-muted);
		border-width: 0 2px 2px 0;
		transform: rotate(-45deg);
		margin-right: 0.15rem;
	}

	[aria-expanded='true'] .chevron {
		transform: rotate(45deg);
	}

	.path {
		font-family: var(--font-code);
		overflow-wrap: anywhere;
	}

	.change,
	.tally {
		color: var(--color-muted);
	}

	.chip,
	.reason,
	.fresh {
		border: 1px solid var(--color-border);
		border-radius: 2rem;
		padding: 0 0.5rem;
		font-size: 0.75rem;
	}

	.chip.link {
		color: var(--color-link);
	}

	.fresh {
		color: var(--color-accent);
		border-color: var(--color-accent);
		font-weight: 700;
	}

	.size {
		margin-left: auto;
	}

	.tick {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-weight: 700;
		cursor: pointer;
	}

	.tick input {
		width: 1rem;
		height: 1rem;
		margin: 0;
	}

	.body {
		overflow: hidden;
		border-radius: 0 0 6px 6px;
	}

	.unmarked,
	.file-change,
	.about,
	.problem {
		margin: 0;
		padding: 0.5rem 0.75rem;
		font-size: 0.875rem;
	}

	.unmarked {
		background: var(--color-attention-background);
		border-bottom: 1px solid var(--color-attention-border);
	}

	.file-change {
		font-weight: 700;
		border-bottom: 1px solid var(--color-border);
	}

	.about {
		color: var(--color-muted);
	}

	.body > button {
		margin: 0 0.75rem 0.75rem;
	}

	.problem {
		color: var(--color-removed);
	}

	.refused {
		border-bottom: 1px solid var(--color-border);
	}

	.tools {
		display: flex;
		justify-content: flex-end;
		padding: 0.25rem 0.75rem;
		border-bottom: 1px solid var(--color-border);
	}

	.tools button {
		font-size: 0.75rem;
		padding: 0.1rem 0.6rem;
	}
</style>
