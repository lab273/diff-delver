import { test } from '../support/journey.ts';

// J13 Visual changes, as far as this build step goes: a changed image compared
// before and after, side by side, with each side's size; an image whose size
// changed, said in words; an added and a deleted image, each with its one
// side; and an SVG, as a picture and as its text. Images are one change each,
// ticked like any file. Snapshot images beside their tests are still to come.
test.describe('J13 Visual changes', () => {
	test('the reviewer compares changed images and ticks them', async ({ journey }) => {
		const images = await journey.repository('images');
		await journey.open((await journey.command([], images)).address);
		const badge = journey.byRole('article', { name: 'assets/badge.png' });
		await journey.press('j');
		await journey.expectFocused(
			journey.byRole('button', { name: 'assets/badge.png', exact: true })
		);
		await journey.expectVisible(
			journey.within(badge).byRole('img', { name: 'Before: assets/badge.png' })
		);
		await journey.expectVisible(
			journey.within(badge).byRole('img', { name: 'After: assets/badge.png' })
		);
		await journey.expectText(badge, 'Before PNG, 48 × 32 pixels, 140 bytes');
		await journey.step('A changed image side by side');

		// An image whose size changed says so, and the two line up at the top left.
		await journey.press('j');
		const banner = journey.byRole('article', { name: 'assets/banner.png' });
		await journey.expectFocused(
			journey.byRole('button', { name: 'assets/banner.png', exact: true })
		);
		await journey.expectText(
			banner,
			'The image changed size, from 40 × 16 pixels to 64 × 24 pixels, so the two are lined up at their top left corners.'
		);
		await journey.step('An image that changed size');

		// An SVG is a picture, and its text is shown below it.
		await journey.press('j');
		const logo = journey.byRole('article', { name: 'assets/logo.svg' });
		await journey.expectFocused(journey.byRole('button', { name: 'assets/logo.svg', exact: true }));
		await journey.expectVisible(
			journey.within(logo).byRole('img', { name: 'After: assets/logo.svg' })
		);
		await journey.expectVisible(
			journey
				.within(logo)
				.byText('<circle cx="16" cy="16" r="9" fill="#27ae60"/>', { exact: false })
		);
		await journey.step('An SVG as a picture and as text');

		// An added image has its one side, as does a deleted one; each is ticked like any file.
		await journey.press('j');
		const added = journey.byRole('article', { name: 'assets/new-icon.png' });
		await journey.expectFocused(
			journey.byRole('button', { name: 'assets/new-icon.png', exact: true })
		);
		await journey.expectVisible(
			journey.within(added).byRole('img', { name: 'Added: assets/new-icon.png' })
		);
		const deleted = journey.byRole('article', { name: 'assets/old-icon.png' });
		await journey.expectVisible(
			journey.within(deleted).byRole('img', { name: 'Deleted: assets/old-icon.png' })
		);
		await journey.step('An added and a deleted image');
		await journey.press('r');
		await journey.expectState(
			journey.within(added).byRole('checkbox', { name: 'Reviewed: assets/new-icon.png' }),
			{ checked: true }
		);
		await journey.step('An image marked as reviewed');
	});
});
