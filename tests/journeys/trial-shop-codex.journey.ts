import { test } from '../support/journey.ts';

// What Codex made of the shop: its recorded trial
// (tests/agent-trials/recordings/shop.codex.json), replayed on the journey's own
// daemon, as the person then sees it: the sections in reading order, one with
// part of a file another section also has, and what was ignored. The page does
// not show the agent's overview, summaries or cross-references yet, so these
// images change when it does.
test.describe('Trial shop sorted by Codex', () => {
	test('the sections in reading order, a split file, and what was ignored', async ({ journey }) => {
		const shop = await journey.repository('trial-shop');
		await journey.open(await journey.agentTrial('shop.codex.json', shop));
		await journey.expectVisible(
			journey.byRole('heading', { level: 2, name: 'Round item prices up to five cents' })
		);
		await journey.step('Sections in reading order');

		const groups = journey.byRole('navigation', { name: 'Groups' });
		const split = 'Apply a percentage discount to the cart subtotal';
		await journey.activate(journey.within(groups).byRole('link', { name: split, exact: true }));
		await journey.expectInView(journey.byRole('heading', { level: 2, name: split }));
		await journey.step('A section with part of a file');

		await journey.activate(journey.within(groups).byRole('link', { name: 'Ignored', exact: true }));
		await journey.expectInView(journey.byRole('heading', { level: 2, name: 'Ignored' }));
		await journey.step('What was ignored');
	});
});
