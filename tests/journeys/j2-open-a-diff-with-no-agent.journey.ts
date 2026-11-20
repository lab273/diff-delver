import { expect, test } from '../support/journey.ts';

// J2 Open a diff with no agent, as far as the first build step goes: what
// `diff-delver` opens when there are no uncommitted changes, when several
// changes could be meant, and when there is nothing new to review.
test.describe('J2 Open a diff with no agent', () => {
	test('the command opens the branch, offers a choice, or says there is nothing new', async ({
		journey
	}) => {
		// On a branch ahead of main, with nothing uncommitted: the branch compared with main.
		const feature = await journey.repository('feature-branch');
		const opened = await journey.command([], feature);
		expect(opened.output).toContain(
			'discounts compared with main in feature-branch: 2 files changed'
		);
		await journey.open(opened.address);
		await journey.expectVisible(
			journey.byRole('heading', { level: 1, name: 'discounts compared with main' })
		);
		await journey.expectText(
			journey.byRole('status'),
			'No changes in the repository since you opened it.'
		);
		const notSorted = journey.byRole('region', { name: /Not sorted yet/ });
		await journey.expectVisible(journey.within(notSorted).byText('src/app.ts'));
		await journey.expectVisible(journey.within(notSorted).byText('src/discount.ts'));
		await journey.step('The branch compared with main');

		// A mistyped branch: the page says what was asked for and why it could not
		// be opened, then offers the one thing that can be.
		const mistyped = await journey.command(['open', 'mian...discounts'], feature);
		expect(mistyped.output).toContain('mian');
		await journey.open(mistyped.address);
		await journey.expectVisible(
			journey.byRole('heading', {
				level: 1,
				name: 'discounts compared with mian could not be opened in feature-branch'
			})
		);
		await journey.expectVisible(journey.byText(/^git does not know "mian" in this repository\./));
		await journey.expectVisible(
			journey.byRole('heading', { level: 2, name: 'You could review instead' })
		);
		await journey.expectVisible(
			journey.byRole('button', { name: 'discounts compared with main (2 files)' })
		);
		await journey.step('A source that could not be opened');

		// Ahead of both main and master: either could be the main branch, so it asks.
		const two = await journey.repository('two-main-branches');
		const choosing = await journey.command([], two);
		expect(choosing.output).toContain(
			'Several changes could be reviewed in two-main-branches; choose one in your browser.'
		);
		await journey.open(choosing.address);
		await journey.expectVisible(
			journey.byRole('heading', {
				level: 1,
				name: 'What would you like to review in two-main-branches?'
			})
		);
		const master = journey.byRole('button', { name: 'discounts compared with master (2 files)' });
		await journey.expectVisible(
			journey.byRole('button', { name: 'discounts compared with main (1 file)' })
		);
		await journey.expectVisible(master);
		await journey.step('A choice of what to review');

		await journey.activate(master);
		await journey.expectVisible(
			journey.byRole('heading', { level: 1, name: 'discounts compared with master' })
		);
		expect(await journey.address()).toBe('/diffs/r_2');
		await journey.expectText(
			journey.byRole('status'),
			'No changes in the repository since you opened it.'
		);
		await journey.step('The chosen comparison');

		// On main with nothing new: it says so, and offers the last commit.
		const quiet = await journey.repository('nothing-new');
		const nothing = await journey.command([], quiet);
		expect(nothing.output).toMatch(/^There is nothing new to review/);
		await journey.open(nothing.address);
		await journey.expectVisible(
			journey.byRole('heading', { level: 1, name: 'Nothing to review in nothing-new' })
		);
		await journey.expectVisible(journey.byRole('button', { name: 'The last commit (1 file)' }));
		await journey.step('Nothing new to review');
	});
});
