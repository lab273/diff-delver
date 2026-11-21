import { expect, test } from '../support/journey.ts';

// J2 Open a diff with no agent, as far as this build step goes: what
// `diff-delver` opens when there are no uncommitted changes, when several
// changes could be meant, and when there is nothing new to review; then a diff
// with every awkward kind of change, all under "Not sorted yet": a rename and a
// file made executable shown and ticked, odd characters shown for what they
// are, a binary file and a large one, the lockfile ignored with its reason,
// and the by-file view with every file once.
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

		// Every awkward kind of change, and no agent: everything waits under "Not sorted yet".
		const assorted = await journey.repository('assorted');
		const awkward = await journey.command([], assorted);
		await journey.open(awkward.address);
		const all = journey.byRole('region', { name: 'Not sorted yet' });
		await journey.expectVisible(
			journey
				.within(all)
				.byText('No agent has sorted this diff into sections, so every file is listed here.')
		);
		// A binary file says what it is; a large one waits to be asked for; odd
		// characters show for what they are, and markup as text.
		const image = journey.byRole('article', { name: 'assets/logo.png' });
		await journey.expectText(
			image,
			'A binary file, so it is not shown as text: 8 bytes before, 14 bytes after.'
		);
		const prices = journey.byRole('article', { name: 'data/prices.csv' });
		await journey.expectText(prices, 'This is a large change: 901 lines.');
		// A file whose name is not valid UTF-8 shows its name escaped.
		await journey.expectVisible(journey.byRole('article', { name: 'notes/caf\\xE9.txt' }));
		// Names with characters that turn text round or cannot be seen show them written out.
		const reversed = journey.byRole('article', { name: 'notes/report\\u202Etxt.exe' });
		await journey.expectText(reversed, 'notes/report\\u202Etxt.exe');
		await journey.expectVisible(
			journey.within(reversed).byRole('checkbox', { name: 'Reviewed: notes/report\\u202Etxt.exe' })
		);
		await journey.expectText(
			journey.byRole('article', { name: 'notes/a\\u200Bb.txt' }),
			'notes/a\\u200Bb.txt'
		);
		const odd = journey.byRole('article', { name: 'notes/odd.txt' });
		await journey.expectVisible(
			journey.within(odd).byText('<b>Not bold</b> &amp; not an entity', { exact: false })
		);
		await journey.expectVisible(journey.within(odd).byText('\\u202E'));
		await journey.expectVisible(journey.within(odd).byText('No newline at end of file'));
		await journey.step('A diff with every kind of change');

		// A rename and a mode change are changes like any other, said in words, and ticked.
		const renamed = journey.byRole('article', { name: 'src/new-name.ts' });
		await journey.expectVisible(
			journey.within(renamed).byText('renamed from src/old-name.ts', { exact: true })
		);
		const script = journey.byRole('article', { name: 'scripts/build.sh' });
		await journey.expectVisible(journey.within(script).byText('made executable', { exact: true }));
		await journey.activate(
			journey.within(renamed).byRole('checkbox', { name: 'Reviewed: src/new-name.ts' }),
			'Space'
		);
		await journey.expectState(
			journey.within(renamed).byRole('checkbox', { name: 'Reviewed: src/new-name.ts' }),
			{ checked: true }
		);
		await journey.step('Changes to files themselves');

		await journey.activate(
			journey.within(prices).byRole('button', { name: 'Show this large change' })
		);
		await journey.expectVisible(journey.within(prices).byText('item-1,0.99'));
		await journey.step('The large change shown');

		// Moving on from it, past its 901 lines, to the files near the end of a long
		// page: each comes to rest at the top of the screen, whatever was drawn first.
		await journey.press('j');
		await journey.expectFocused(
			journey.byRole('button', { name: 'notes/a\\u200Bb.txt', exact: true })
		);
		await journey.press('j');
		await journey.press('j');
		await journey.expectFocused(journey.byRole('button', { name: 'notes/odd.txt', exact: true }));
		await journey.step('A file near the end of a long page');

		// Every file once, with where its changes are: the lockfile is there too, ignored.
		await journey.activate(journey.byRole('button', { name: 'By file' }));
		const files = journey.byRole('region', { name: /^Every file/ });
		await journey.expectFocused(journey.byRole('heading', { name: /^Every file/ }));
		await journey.expectText(files, 'package-lock.json');
		await journey.expectText(files, 'Ignored, not counted');
		await journey.expectState(
			journey.within(files).byRole('checkbox', { name: 'Reviewed: src/new-name.ts' }),
			{ checked: true }
		);
		await journey.activate(
			journey.within(files).byRole('checkbox', { name: 'Reviewed: scripts/build.sh' }),
			'Space'
		);
		await journey.expectState(
			journey.within(files).byRole('checkbox', { name: 'Reviewed: scripts/build.sh' }),
			{ checked: true }
		);
		await journey.step('Every file once');
	});
});
