import { expect, test } from '../support/journey.ts';

// J0 First run, as far as the first build step goes: the empty home page with
// the one command to run, the command opening a repository's uncommitted
// changes, and home listing them.
test.describe('J0 First run', () => {
	test('a newcomer runs one command in a repository and reads the diff it opens', async ({
		journey
	}) => {
		// The address `diff-delver serve` prints, before anything has been opened.
		const served = await journey.command(['serve']);
		await journey.open(served.address);

		await journey.expectVisible(journey.byRole('heading', { level: 1, name: 'Your diffs' }));
		await journey.expectVisible(journey.byText('There are no diffs in diff delver.'));
		// The token in the address the command opens is taken out of it at once.
		expect(await journey.address()).toBe('/');
		expect(await journey.title()).toBe('diff delver');
		expect(await journey.tabOrder()).toEqual(['link "diff delver"', 'button "Copy the command"']);
		await journey.activate(journey.byRole('button', { name: 'Copy the command' }));
		expect(await journey.readClipboard()).toBe('npx github:lab273/diff-delver');
		await journey.expectVisible(
			journey.byText('Copied. Paste it into a terminal, in your repository.')
		);
		await journey.step('Start page');

		const shop = await journey.repository('shop');
		const run = await journey.command([], shop);
		expect(run.output).toContain(
			'Uncommitted changes in shop: 3 files changed, 11 lines added and 3 removed.'
		);
		await journey.open(run.address);
		expect(await journey.address()).toBe('/diffs/r_1');
		await journey.expectVisible(
			journey.byRole('heading', { level: 1, name: 'Uncommitted changes' })
		);
		await journey.expectText(
			journey.byRole('status'),
			'No changes in the repository since you opened it.'
		);
		const notSorted = journey.byRole('region', { name: /Not sorted yet/ });
		await journey.expectVisible(journey.within(notSorted).byText('src/discount.ts'));
		await journey.expectVisible(journey.within(notSorted).byText('src/cart.ts'));
		// A new file only adds lines: its size says so and nothing more, as GitHub's does.
		const added = await journey.textOf(
			journey.nth(journey.within(notSorted).byRole('listitem'), 2)
		);
		expect(added).toMatch(/^src\/discount\.ts\s+added\s+\+5\s+added$/);
		const ignored = journey.byRole('region', { name: /Ignored/ });
		await journey.expectVisible(journey.within(ignored).byText('pnpm-lock.yaml'));
		await journey.expectVisible(journey.within(ignored).byText('Lockfile'));
		await journey.step('The uncommitted changes');

		await journey.activate(journey.byRole('link', { name: 'See all your diffs' }));
		await journey.expectVisible(journey.byRole('heading', { level: 1, name: 'Your diffs' }));
		const listed = journey.byRole('listitem');
		await journey.expectVisible(
			journey.within(listed).byRole('link', { name: 'Uncommitted changes' })
		);
		await journey.expectText(listed, 'shop');
		await journey.expectText(listed, 'Last active just now');
		await journey.expectText(listed, 'Not started: 11 changes to review');
		await journey.step('Home lists the diff');
	});
});
