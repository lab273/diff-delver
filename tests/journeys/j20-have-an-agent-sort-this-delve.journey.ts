import { expect, test } from '../support/journey.ts';

// J20 Have an agent sort this Delve: on a Delve no agent has sorted, the
// reviewer opens the instructions where the page says "Not sorted yet", and
// finds the command that connects an agent to this copy of diff delver, the
// folder to start the agent in and a sentence that names this very Delve, each
// to copy. When an agent connects the page says so, and when its first
// sections arrive the instructions give way to them. Keyboard only.
test.describe('J20 Have an agent sort this Delve', () => {
	test('the reviewer copies what to give an agent, and the agent’s sections take over', async ({
		journey
	}) => {
		const shop = await journey.repository('trial-shop');
		const opened = await journey.command([], shop);
		const report = new URL(opened.address).pathname.split('/').at(-1);
		await journey.open(opened.address);
		await journey.expectVisible(
			journey.byRole('heading', { level: 1, name: 'Uncommitted changes' })
		);

		// Where the page says nothing is sorted, it offers how to have an agent sort it.
		const unsorted = journey.byRole('region', { name: 'Not sorted yet' });
		const offer = journey.within(unsorted).byRole('button', { name: 'Have an agent sort this' });
		await journey.tabTo(offer);
		await journey.expectState(offer, { expanded: false });

		// Three steps, in place: the command for this copy, the folder, and the sentence.
		await journey.press('Enter');
		await journey.expectState(offer, { expanded: true });
		const steps = journey.byRole('region', { name: 'Have a coding agent sort this Delve' });
		const sentence = `Sort diff delver report ${report ?? ''} into sections for review: “Uncommitted changes” in shop. The report already exists, so do not create another one. Start with get_manifest for report ${report ?? ''}.`;
		await journey.expectText(
			steps,
			'claude mcp add --scope user diff-delver -- npx --yes https://github.com/lab273/diff-delver/releases/latest/download/diff-delver.tgz mcp'
		);
		await journey.expectText(steps, 'cd ~/src/shop');
		await journey.expectText(steps, sentence);
		await journey.step('How to have an agent sort this Delve');

		// Each is copied exactly as shown.
		const inSteps = journey.within(steps);
		await journey.activate(inSteps.byRole('button', { name: 'Copy the sentence' }));
		expect(await journey.readClipboard()).toBe(sentence);
		await journey.expectVisible(inSteps.byText('Copied. Paste it to your agent.'));
		await journey.activate(inSteps.byRole('button', { name: 'Copy the folder' }));
		expect(await journey.readClipboard()).toBe('cd ~/src/shop');

		// For Codex, the entry its settings file takes instead of a command.
		const agents = inSteps.byRole('group', { name: 'Your agent' });
		await journey.tabTo(journey.within(agents).byRole('radio', { name: 'Claude Code' }));
		await journey.press('ArrowRight');
		await journey.expectState(journey.within(agents).byRole('radio', { name: 'Codex' }), {
			checked: true
		});
		await journey.expectText(steps, '[mcp_servers.diff-delver]');
		await journey.activate(inSteps.byRole('button', { name: 'Copy the entry' }));
		expect(await journey.readClipboard()).toBe(
			[
				'[mcp_servers.diff-delver]',
				'command = "npx"',
				'args = ["--yes", "https://github.com/lab273/diff-delver/releases/latest/download/diff-delver.tgz", "mcp"]'
			].join('\n')
		);
		await journey.step('The sentence copied, and the entry for Codex');

		// An agent started in another repository: the page says where, and what to do.
		const reading = await journey.repository('reading');
		await journey.agentLink(reading);
		await journey.returnToPage();
		await journey.expectText(
			steps,
			'An agent connected to this diff delver a moment ago, started in ~/src/reading. It is set up, so start it in the folder of step 2 and paste it the sentence of step 3.'
		);

		// The reviewer starts their agent in the repository. Back on the page, it says one connected.
		await journey.agentLink(shop);
		await journey.returnToPage();
		await journey.expectText(
			steps,
			'An agent connected to this diff delver a moment ago, started in ~/src/shop. That is this Delve’s repository, so you can go straight to step 3.'
		);
		await journey.step('An agent has connected');

		// The agent's first sections arrive: the instructions give way to them, and the
		// button stays while something is still not sorted.
		await journey.agentCalls([
			{
				tool: 'upsert_sections',
				args: {
					report,
					version: 1,
					sections: [
						{ id: 'rounding', title: 'Prices round up to five cents' },
						{ id: 'discounts', title: 'A cart total can take a discount' }
					]
				}
			},
			{
				tool: 'assign',
				args: {
					report,
					version: 1,
					items: [
						{ file: 'src/pricing.ts', hunks: ['h1'], section: 'rounding' },
						{ file: 'src/pricing.test.ts', section: 'rounding', role: 'test' },
						{ file: 'src/pricing.ts', section: 'discounts' },
						{ file: 'src/cart.ts', section: 'discounts' }
					]
				}
			}
		]);
		await journey.returnToPage();
		await journey.expectVisible(
			journey.byRole('heading', { level: 2, name: 'Prices round up to five cents' })
		);
		await journey.expectHidden(steps);
		await journey.expectVisible(
			journey
				.within(unsorted)
				.byText(
					'An agent has started sorting this Delve. Its sections appear on this page as it makes them.'
				)
		);
		await journey.expectFocused(offer);
		await journey.expectState(offer, { expanded: false });
		await journey.step('The agent’s first sections');

		// Everything sorted: nothing is left to offer an agent.
		await journey.agentCalls([
			{
				tool: 'upsert_sections',
				args: {
					report,
					version: 1,
					sections: [{ id: 'housekeeping', title: 'Deploy script and docs' }]
				}
			},
			{
				tool: 'assign',
				args: {
					report,
					version: 1,
					items: [
						{ file: 'scripts/deploy.sh', section: 'housekeeping' },
						{ file: 'docs/handbook.md', section: 'housekeeping' },
						{ glob: 'fixtures/**', section: 'ignored', reason: 'Re-recorded HTTP fixture data.' }
					]
				}
			}
		]);
		await journey.returnToPage();
		await journey.expectVisible(
			journey.byRole('heading', { level: 2, name: 'Deploy script and docs' })
		);
		await journey.expectHidden(journey.byRole('heading', { level: 2, name: 'Not sorted yet' }));
		await journey.expectHidden(journey.byRole('button', { name: 'Have an agent sort this' }));
		await journey.step('Everything sorted by the agent');
	});
});
