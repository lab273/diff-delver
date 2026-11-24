<!--
	How to have a coding agent sort this Delve, offered where the page lists
	what is not sorted yet: one button that opens three steps in place, each with
	something to copy that is for this copy of diff delver, this Delve's
	repository and this Delve (`#lib/core/agent-setup/`).

	What the steps need is asked of the daemon when they are opened, not with
	the page, and again when the person comes back to the page, as from the
	terminal they pasted into, so the page says when an agent has connected.
	When they first come, the page moves just far enough to show all three.

	Whether it is open belongs to the Delve's page, which draws this again when
	the sections change and puts it away when an agent's first sections arrive.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { describeApiError } from '#lib/api/client.ts';
	import type { AgentSorting } from '#lib/api/schemas.ts';
	import type { ReportId } from '#lib/core/report-id.tiny.ts';
	import CopyText from '#lib/ui/CopyText.svelte';
	import VisibleText from '#lib/ui/VisibleText.svelte';
	import { pageClient } from '#lib/ui/client.ts';

	let {
		id,
		open = $bindable(),
		started
	}: {
		id: ReportId;
		open: boolean;
		/** An agent's sections arrived while this page was open. */
		started: boolean;
	} = $props();

	/** Where the README says how to give an agent the project's skill. */
	const README_ADDRESS = 'https://github.com/lab273/diff-delver#have-a-coding-agent-sort-the-diff';

	type Agent = 'claudeCode' | 'codex' | 'other';
	const AGENTS: readonly { readonly agent: Agent; readonly name: string }[] = [
		{ agent: 'claudeCode', name: 'Claude Code' },
		{ agent: 'codex', name: 'Codex' },
		{ agent: 'other', name: 'Another agent' }
	];
	let agent = $state<Agent>('claudeCode');

	let found = $state<AgentSorting>();
	let problem = $state<string>();

	let whole = $state<HTMLElement>();

	/** Brings the steps into view when they would end below the screen: all of them, or their start. */
	function show(): void {
		if (whole === undefined) return;
		const box = whole.getBoundingClientRect();
		if (box.bottom <= window.innerHeight) return;
		whole.scrollIntoView({ block: box.height <= window.innerHeight ? 'end' : 'start' });
	}

	async function ask(): Promise<void> {
		const answer = await pageClient().agentSorting(id);
		if (answer.ok) {
			const first = found === undefined;
			found = answer.value;
			problem = undefined;
			if (first) {
				await tick();
				show();
			}
		} else if (found === undefined) {
			// What is already shown stays when asking again fails.
			problem = describeApiError(answer.error);
		}
	}

	$effect(() => {
		if (!open) return;
		void ask();
		const back = (): void => {
			if (document.visibilityState === 'visible') void ask();
		};
		window.addEventListener('focus', back);
		document.addEventListener('visibilitychange', back);
		return () => {
			window.removeEventListener('focus', back);
			document.removeEventListener('visibilitychange', back);
		};
	});
</script>

<div class="agent" data-agent-help bind:this={whole}>
	<button
		type="button"
		class="toggle"
		aria-expanded={open}
		aria-controls="agent-help-steps"
		onclick={() => (open = !open)}
	>
		Have an agent sort this
	</button>
	{#if started && !open}
		<p class="started" role="status">
			An agent has started sorting this Delve. Its sections appear on this page as it makes them.
		</p>
	{/if}
	{#if open}
		<section
			id="agent-help-steps"
			class="steps"
			aria-labelledby="agent-help-heading"
			aria-busy={found === undefined && problem === undefined}
		>
			<h3 id="agent-help-heading">Have a coding agent sort this Delve</h3>
			{#if problem !== undefined}
				<p class="problem" role="alert">{problem}</p>
				<button type="button" onclick={ask}>Try again</button>
			{:else if found !== undefined}
				{#if found.worked !== null}
					<p class="heard" role="status"><VisibleText text={found.worked} /></p>
				{/if}
				<ol>
					<li>
						<h4>Connect your agent to this diff delver, once</h4>
						<div role="status">
							{#if found.heard !== null}
								<p class="heard">
									<VisibleText text={found.heard.text} />
									{found.heard.here
										? 'That is this Delve’s repository, so you can go straight to step 3.'
										: ''}
								</p>
							{/if}
						</div>
						<fieldset>
							<legend>Your agent</legend>
							{#each AGENTS as choice (choice.agent)}
								<label>
									<input
										type="radio"
										name="agent-help-agent"
										value={choice.agent}
										bind:group={agent}
									/>
									{choice.name}
								</label>
							{/each}
						</fieldset>
						{#if agent === 'claudeCode'}
							<p>Run this in a terminal, in the folder of step 2:</p>
							<CopyText
								text={found.connect.claudeCode}
								label="Copy the command"
								copied="Copied. Paste it into a terminal, in the folder of step 2."
							/>
						{:else if agent === 'codex'}
							<p>Add this to Codex’s settings file, <code>~/.codex/config.toml</code>:</p>
							<CopyText
								text={found.connect.codex}
								label="Copy the entry"
								copied="Copied. Paste it into Codex’s config.toml."
							/>
						{:else}
							<p>Add an MCP server to your agent that runs this command:</p>
							<CopyText
								text={found.connect.other}
								label="Copy the command"
								copied="Copied. Paste it where your agent keeps its MCP servers."
							/>
						{/if}
					</li>
					<li>
						<h4>Start the agent in this Delve’s repository</h4>
						{#if found.folder.there}
							<p>The agent reads the code there. In a terminal, go to the folder and start it:</p>
							<CopyText
								text={found.folder.command}
								label="Copy the folder"
								copied="Copied. Paste it into a terminal, then start your agent."
							/>
						{:else}
							<p>
								Its folder, <code><VisibleText text={found.folder.shown} /></code>, is no longer
								there. If the repository has moved, start the agent where it is now: the sentence in
								step 3 finds this Delve from any folder.
							</p>
						{/if}
					</li>
					<li>
						<h4>Ask it</h4>
						<p>Paste this to the agent. It names this Delve, so the agent sorts this one:</p>
						<CopyText
							text={found.request}
							label="Copy the sentence"
							copied="Copied. Paste it to your agent."
						/>
					</li>
				</ol>
				<p class="more">
					The sections appear here as the agent makes them. It sorts better with the project’s
					skill, which
					<a href={README_ADDRESS} target="_blank" rel="noopener noreferrer">
						the README explains
					</a>.
				</p>
			{:else}
				<p>Working out the commands for this Delve…</p>
			{/if}
		</section>
	{/if}
</div>

<style>
	.agent {
		scroll-margin: 1rem;
		margin: 0 0 0.75rem;
	}

	.started {
		margin: 0.5rem 0 0;
		font-size: 0.875rem;
	}

	.steps {
		max-width: 46rem;
		margin-top: 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		padding: 0.75rem 1rem 0.25rem;
		font-size: 0.875rem;
	}

	h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}

	h4 {
		margin: 0 0 0.25rem;
		font-size: 0.875rem;
	}

	p {
		margin: 0 0 0.5rem;
	}

	ol {
		margin: 0;
		padding-left: 1.5rem;
	}

	li {
		margin-bottom: 0.75rem;
	}

	li::marker {
		font-weight: 700;
	}

	fieldset {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1.25rem;
		margin: 0 0 0.5rem;
		border: 0;
		padding: 0;
	}

	legend {
		float: left;
		margin-right: 1.25rem;
		padding: 0;
		color: var(--color-muted);
	}

	label {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}

	label input {
		margin: 0;
	}

	.heard {
		border-left: 3px solid var(--color-border);
		padding-left: 0.625rem;
	}

	.more {
		color: var(--color-muted);
	}

	.problem {
		color: var(--color-danger, inherit);
	}
</style>
