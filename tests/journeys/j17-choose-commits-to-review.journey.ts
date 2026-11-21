import { expect, test } from '../support/journey.ts';

// J17 Choose commits to review: `diff-delver choose` opens the choose page for a
// repository, with its branches and the checked-out one's commits, each with
// its size and when it was made, and when the repository last fetched. A run
// of commits is ticked with the keyboard (ticking a second takes in every
// commit between) and opened, titled by its commits; a whole branch is opened compared with the main
// branch; the remote is asked whether it has moved on; a branch is found by
// name; and the start page leads here too.
test.describe('J17 Choose commits to review', () => {
	test('the reviewer picks a run of commits or a whole branch, and sees whether origin has moved on', async ({
		journey
	}) => {
		const shop = await journey.repository('history');
		const chose = await journey.command(['choose'], shop);
		expect(chose.output).toContain(
			'Choose commits, or a whole branch, to review in shop, in your browser.'
		);
		await journey.open(chose.address);
		await journey.expectVisible(
			journey.byRole('heading', { level: 1, name: 'Choose what to review in shop' })
		);
		await journey.expectVisible(
			journey.byText('Last fetched from origin 2 days ago (13 January 2026, 09:30 UTC).')
		);
		const discounts = journey.byRole('radio', { name: /^discounts/ });
		await journey.expectState(discounts, { checked: true });
		await journey.expectText(
			journey.byRole('group', { name: 'Branch to show' }),
			'3 commits not on origin/main'
		);
		const commits = journey.byRole('region', { name: 'Commits on discounts' });
		await journey.expectVisible(
			journey
				.within(commits)
				.byText(
					'discounts started from origin/main here: the commits below are on origin/main too.'
				)
		);
		await journey.expectText(commits, '3 days ago (11 January 2026, 21:30 UTC)');
		await journey.step('The branches and commits');

		// Two ticks make a run: the newest and the oldest of the branch's own, and all between.
		const newest = journey.byRole('checkbox', { name: /^Say which code was used/ });
		const middle = journey.byRole('checkbox', { name: /^Apply discounts at checkout/ });
		const oldest = journey.byRole('checkbox', { name: /^Add a discount rate/ });
		await journey.activate(newest, 'Space');
		await journey.activate(oldest, 'Space');
		await journey.expectState(middle, { checked: true });
		const ticked = journey.byRole('region', { name: 'Ticked commits' });
		await journey.expectText(
			ticked,
			/^3 commits, from “Add a discount rate” to “Say which code was used”: 3 files changed, \d+ lines added and \d+ removed/
		);
		await journey.expectVisible(journey.byRole('button', { name: 'Review these 3 commits' }));
		await journey.step('A run of commits ticked');

		// Unticking one in the middle keeps the newer part, and says why.
		await journey.activate(middle, 'Space');
		await journey.expectState(oldest, { checked: false });
		await journey.expectText(
			ticked,
			'Only commits next to each other can be reviewed as one diff, so the older commit below it was unticked too.'
		);
		await journey.step('Unticking one in the middle');

		await journey.activate(oldest, 'Space');
		await journey.expectState(middle, { checked: true });
		await journey.activate(journey.byRole('button', { name: 'Review these 3 commits' }));
		// The diff is named by its commits: how many, and the oldest and newest.
		const run = '3 commits: “Add a discount rate” to “Say which code was used”';
		await journey.expectVisible(journey.byRole('heading', { level: 1, name: run }));
		await journey.expectVisible(
			journey.within(journey.byRole('region', { name: 'Not sorted yet' })).byText('src/discount.ts')
		);
		await journey.step('The ticked commits opened');

		// Another branch, with the arrow keys: the local main, with its merge. It is
		// a branch like any other, one commit ahead of origin/main, the main branch.
		const again = await journey.command(['choose'], shop);
		await journey.open(again.address);
		await journey.tabTo(discounts);
		await journey.press('ArrowDown');
		const main = journey.byRole('radio', { name: /^main/ });
		await journey.expectState(main, { checked: true });
		await journey.expectVisible(
			journey.byRole('radio', { name: /^main 1 commit not on origin\/main, last commit/ })
		);
		const onMain = journey.byRole('region', { name: 'Commits on main' });
		await journey.expectVisible(journey.within(onMain).byText('Merge the tidier styles'));
		await journey.expectVisible(journey.within(onMain).byText('Merge', { exact: true }));
		await journey.expectVisible(
			journey.byRole('button', {
				name: 'Review the whole branch: 1 commit, compared with origin/main'
			})
		);
		// The main branch is the remote's: its tag says so, as a remote branch's does.
		await journey.expectVisible(
			journey.byRole('radio', { name: /^origin\/main On origin Main branch/ })
		);
		await journey.step('A local main ahead of the main branch');

		// The whole branch, compared with the main branch.
		await journey.press('ArrowUp');
		await journey.expectState(discounts, { checked: true });
		await journey.activate(
			journey.byRole('button', {
				name: 'Review the whole branch: 3 commits, compared with origin/main'
			})
		);
		await journey.expectVisible(
			journey.byRole('heading', { level: 1, name: 'discounts compared with origin/main' })
		);
		await journey.step('The whole branch opened');

		// Both are in the list of diffs, each under the name its page has.
		await journey.activate(journey.byRole('link', { name: 'See all your Delves' }));
		await journey.expectVisible(journey.byRole('heading', { level: 1, name: 'Your Delves' }));
		await journey.expectVisible(journey.byRole('link', { name: run }));
		await journey.expectVisible(
			journey.byRole('link', { name: 'discounts compared with origin/main' })
		);
		await journey.step('The run and the branch in the list of diffs');

		// Asking origin whether it has moved on: only when the button is pressed.
		const third = await journey.command(['choose'], shop);
		await journey.open(third.address);
		await journey.activate(journey.byRole('button', { name: 'Check origin for new commits' }));
		const remote = journey.byRole('region', { name: 'Your copy and its remote' });
		await journey.expectText(
			remote,
			'origin has new commits on main that this copy has not fetched.'
		);
		await journey.expectVisible(
			journey.within(remote).byText('git fetch -- origin', { exact: true })
		);
		await journey.step('Origin has moved on');

		// A branch found by name, and its commits shown.
		await journey.tabTo(journey.byRole('searchbox', { name: 'Find a branch' }));
		await journey.type('menu');
		const menu = journey.byRole('radio', { name: /^origin\/new-menu On origin/ });
		await journey.expectVisible(menu);
		await journey.expectHidden(discounts);
		// The commits shown, and what can be done with them, stay as they were.
		await journey.expectVisible(
			journey.byRole('button', {
				name: 'Review the whole branch: 3 commits, compared with origin/main'
			})
		);
		await journey.expectVisible(journey.byRole('region', { name: 'Commits on discounts' }));
		await journey.tabTo(menu);
		await journey.press('Space');
		await journey.expectVisible(
			journey
				.within(journey.byRole('region', { name: 'Commits on origin/new-menu' }))
				.byText('Add a menu')
		);
		await journey.step('A branch found by name');

		// The start page leads here too, when there is nothing else to review.
		const staged = await journey.command(['open', 'staged'], shop);
		await journey.open(staged.address);
		const way = journey.byRole('link', { name: 'Choose commits or a branch' });
		await journey.expectVisible(way);
		await journey.step('The way in from the start page');
		await journey.activate(way);
		await journey.expectVisible(
			journey.byRole('heading', { level: 1, name: 'Choose what to review in shop' })
		);
		expect(await journey.address()).toMatch(/^\/choose\?directory=/);
	});
});
