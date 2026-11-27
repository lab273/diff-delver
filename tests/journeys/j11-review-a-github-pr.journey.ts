import { expect, test } from '../support/journey.ts';

// J11 Review a GitHub PR (part 1, opening and following it): the choose page
// of a clone of a repository on GitHub offers its pull requests without asking
// GitHub until the reviewer presses the button; the list shows each open one
// with who opened it, its branches, when it was updated and whether it is a
// draft; one is opened as a Delve with the keyboard, with a link to it on
// GitHub by its title; someone pushes a commit
// to it on GitHub, the command is run again for it, and the Delve becomes its
// next version, with the tick on what did not change kept and what is new
// marked new. Then the reviewer comments on a line and writes an overall
// review, and finishing posts them to the pull request as one GitHub review,
// published as a comment, with a link to it on GitHub, after showing what
// will be posted; and a second review, with the tick box, as a draft on
// GitHub; and the list of Delves links to the pull request on GitHub. The
// links are never followed: they lead to github.com.
test.describe('J11 Review a GitHub PR', () => {
	test('the reviewer opens a pull request from the list, follows it to its next version, and posts the review to it', async ({
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
		const onGitHub = journey.byRole('link', { name: 'Pull request #7 on GitHub', exact: true });
		await journey.tabTo(onGitHub);
		expect(await journey.destinationOf(onGitHub)).toBe('https://github.com/acme/shop/pull/7');
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

		// A comment on the new file's line, and an overall review.
		const coupon = journey.within(journey.byRole('article', { name: 'src/coupon.ts' }));
		await journey.activate(
			coupon.byRole('button', { name: 'Comment on, flag or ask about line 1, after', exact: true })
		);
		// The menu under the line: Comment, or Flag.
		await journey.activate(
			journey.byRole('button', { name: 'Comment on After, line 1', exact: true })
		);
		const box = journey.within(
			journey.byRole('form', { name: 'New comment on After, line 1', exact: true })
		);
		await journey.expectFocused(box.byRole('textbox', { name: 'Comment', exact: true }));
		await journey.type('Read the coupons from settings.');
		await journey.activate(box.byRole('button', { name: 'Save comment', exact: true }));
		const bar = journey.within(journey.byRole('region', { name: 'Overall review' }));
		await journey.expectVisible(bar.byText('1 comment', { exact: true }));
		await journey.press('v');
		await journey.expectFocused(
			bar.byRole('textbox', { name: /^Your overall review of the change/ })
		);
		await journey.type('The discount reads well. One question on the coupons.');
		await journey.press('Control+Enter');
		await journey.expectHidden(bar.byText('Not saved', { exact: true }));
		await journey.press('Escape');

		// From the bar to finishing, which on a pull request offers to post to it.
		await journey.activate(bar.byRole('button', { name: 'Finish your review', exact: true }));
		const finish = journey.within(journey.byRole('region', { name: 'Finish your review' }));
		const post = finish.byRole('button', { name: 'Finish and post to GitHub', exact: true });
		await journey.expectFocused(post);
		await journey.expectText(
			journey.byRole('region', { name: 'Finish your review' }),
			'It is posted to acme/shop#7 on GitHub as one review from your GitHub account'
		);
		const asComment = finish.byRole('radio', { name: 'Comment', exact: true });
		await journey.expectState(asComment, { checked: true });
		await journey.expectVisible(finish.byRole('button', { name: 'Finish and copy only' }));
		await journey.step('Finishing offers to post to GitHub');

		// What GitHub will have, before it is posted.
		await journey.activate(
			finish.byRole('button', { name: 'Show what will be posted', exact: true })
		);
		const willPost = journey.byRole('region', { name: 'What will be posted to GitHub' });
		await journey.expectText(willPost, 'The discount reads well. One question on the coupons.');
		await journey.expectVisible(finish.byText('On their lines on GitHub', { exact: true }));
		await journey.step('What will be posted to GitHub');

		await journey.activate(post);
		await journey.expectVisible(
			finish.byText('Review 1 is finished, posted to GitHub as a comment, and copied.', {
				exact: false
			})
		);
		await journey.expectVisible(finish.byText('Posted to GitHub as a comment —', { exact: false }));
		await journey.expectVisible(
			finish.byRole('link', { name: 'open review 1 on GitHub', exact: true })
		);
		expect(await journey.readClipboard()).toContain('> Read the coupons from settings.');
		await journey.step('Posted to GitHub, with a link to it');

		// A second review, posted as a draft on GitHub: its kind is set aside.
		await journey.activate(
			coupon.byRole('button', { name: 'Comment on, flag or ask about line 1, after', exact: true })
		);
		// The menu under the line: Comment, or Flag.
		await journey.activate(
			journey.byRole('button', { name: 'Comment on After, line 1', exact: true })
		);
		await journey.type('And say which are seasonal.');
		await journey.activate(
			journey
				.within(journey.byRole('form', { name: 'New comment on After, line 1', exact: true }))
				.byRole('button', { name: 'Save comment', exact: true })
		);
		await journey.activate(bar.byRole('button', { name: 'Finish your review', exact: true }));
		await journey.expectFocused(post);
		const asDraft = finish.byRole('checkbox', { name: 'Post as a draft on GitHub', exact: true });
		await journey.activate(asDraft, 'Space');
		await journey.expectState(asDraft, { checked: true });
		await journey.expectState(asComment, { disabled: true });
		await journey.expectVisible(
			finish.byText(
				'As a draft, only you can see the review on GitHub until you submit it there.',
				{
					exact: false
				}
			)
		);
		await journey.step('Posting as a draft on GitHub');

		await journey.activate(post);
		await journey.expectVisible(
			finish.byText(
				'Review 2 is finished, posted to GitHub as a draft, which only you can see there until you submit it, and copied.',
				{ exact: false }
			)
		);
		await journey.expectText(
			finish.byText('Posted as a draft —', { exact: false }),
			'Posted as a draft — open review 2 on GitHub to submit it'
		);
		await journey.expectVisible(
			finish.byRole('link', { name: 'open review 2 on GitHub', exact: true })
		);
		await journey.step('Posted as a draft on GitHub');

		// The list of Delves links to the pull request on GitHub too.
		await journey.activate(
			journey.within(journey.byRole('banner')).byRole('link', { name: 'Your Delves', exact: true })
		);
		await journey.expectVisible(journey.byRole('heading', { level: 1, name: 'Your Delves' }));
		await journey.expectVisible(journey.byRole('link', { name: title, exact: true }));
		const listed = journey.byRole('link', { name: 'Pull request #7 on GitHub', exact: true });
		await journey.tabTo(listed);
		expect(await journey.destinationOf(listed)).toBe('https://github.com/acme/shop/pull/7');
		await journey.step('The list of Delves links to it on GitHub');
	});
});
