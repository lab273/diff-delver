import { expect, test } from '../support/journey.ts';

// J11 Review a GitHub PR (part 1, opening and following it): the choose page
// of a clone of a repository on GitHub offers its pull requests without asking
// GitHub until the reviewer presses the button; the list shows each open one
// with who opened it, its branches, when it was updated and whether it is a
// draft; one is opened as a Delve with the keyboard; someone pushes a commit
// to it on GitHub, the command is run again for it, and the Delve becomes its
// next version, with the tick on what did not change kept and what is new
// marked new. Posting the review to GitHub is part 2, appended after these steps.
test.describe('J11 Review a GitHub PR', () => {
	test('the reviewer opens a pull request from the list, and follows it to its next version', async ({
		journey
	}) => {
		const shop = await journey.repository('on-github');
		const chose = await journey.command(['choose'], shop);
		await journey.open(chose.address);
		const pulls = journey.byRole('region', { name: 'Pull requests on GitHub' });
		await journey.expectText(pulls, 'origin is acme/shop on GitHub.');
		await journey.tabTo(journey.byRole('button', { name: 'Show open pull requests' }));
		await journey.step('The choose page offers pull requests');

		await journey.press('Enter');
		await journey.expectText(
			pulls,
			'2 open pull requests in acme/shop, most recently updated first. Choose one to review it.'
		);
		const discount = journey.byRole('button', { name: /^#7 Add a discount rate/ });
		await journey.expectText(discount, 'By octo, from discount into main, updated 3 hours ago');
		await journey.expectText(
			journey.byRole('button', { name: /^#8 Print a receipt/ }),
			/Draft.*By hubot, from a fork’s receipt into main, updated 2 days ago/
		);
		await journey.tabTo(discount);
		await journey.step('The open pull requests');

		await journey.press('Enter');
		const title = 'Pull request #7: “Add a discount rate”';
		await journey.expectVisible(journey.byRole('heading', { level: 1, name: title }));
		const notSorted = journey.byRole('region', { name: 'Not sorted yet' });
		await journey.expectVisible(journey.within(notSorted).byText('src/discount.ts'));
		await journey.expectVisible(journey.within(notSorted).byText('src/price.ts'));
		await journey.expectText(
			journey.byRole('status'),
			'No changes to the pull request since you opened it.'
		);
		await journey.step('The pull request as a Delve');

		const discountTick = journey.byRole('checkbox', { name: 'Reviewed: src/discount.ts' });
		await journey.activate(discountTick, 'Space');
		await journey.expectState(discountTick, { checked: true });

		// Someone pushes a commit to the pull request on GitHub; running the command
		// for it again asks GitHub, and brings the Delve up to date.
		await journey.pushToPullRequest(
			shop,
			7,
			'src/coupon.ts',
			'export const COUPONS = { SPRING: 0.1 };\n',
			'Add spring coupons'
		);
		const again = await journey.command(['open', 'https://github.com/acme/shop/pull/7'], shop);
		expect(again.output).toContain(
			`${title} in shop, updated to the pull request as it is now on GitHub (version 2).`
		);
		await journey.returnToPage();
		const newer = journey.byRole('region', { name: 'This Delve has a newer version' });
		await journey.expectText(newer, 'It was updated to version 2 while this page was open');
		await journey.activate(
			journey.within(newer).byRole('button', { name: 'Show the new version' })
		);
		const updated = journey.byRole('region', { name: 'Updated to version 2 just now' });
		await journey.expectFocused(
			journey.byRole('heading', { name: 'Updated to version 2 just now' })
		);
		await journey.expectText(updated, '1 file changed: 1 change new to review.');
		await journey.expectState(discountTick, { checked: true });
		await journey.expectText(journey.byRole('article', { name: 'src/coupon.ts' }), '1 new');
		await journey.step('A new commit, as the next version');
	});
});
