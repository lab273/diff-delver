import { test } from '../support/journey.ts';

// J13 Visual changes, as far as this build step goes: a changed image compared
// in each way, by keyboard: side by side, with each side's size; with a slider
// moved by the arrow keys; in onion skin; and by the pixels that changed, with
// how many. An image whose size changed, said in words; an SVG, as a picture
// and as its text; an added and a deleted image, each with its one side.
// Images are one change each, ticked like any file. Snapshot images beside
// their tests are still to come.
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

		// A slider over the two: the image before on its left, after on its right.
		const ways = journey.within(badge);
		await journey.activate(ways.byRole('button', { name: 'Slider' }));
		await journey.expectState(ways.byRole('button', { name: 'Slider' }), { pressed: true });
		const slider = ways.byRole('slider', { name: /^Slider between the image before/ });
		await journey.tabTo(slider);
		for (let n = 0; n < 20; n += 1) await journey.press('ArrowLeft');
		await journey.expectState(slider, { value: '30' });
		await journey.step('Comparing with a slider');

		// Onion skin, from the keyboard, even on the slider: the image after over
		// the one before, as see-through as chosen. The focus goes to the way chosen.
		await journey.press('i');
		await journey.expectState(ways.byRole('button', { name: 'Onion skin' }), { pressed: true });
		await journey.expectFocused(ways.byRole('button', { name: 'Onion skin' }));
		const opacity = ways.byRole('slider', { name: /^How much the image after shows/ });
		await journey.tabTo(opacity);
		for (let n = 0; n < 20; n += 1) await journey.press('ArrowRight');
		await journey.expectState(opacity, { value: '70' });
		await journey.step('Comparing in onion skin');

		// The pixels that changed, in magenta, counted.
		await journey.press('i');
		await journey.expectState(ways.byRole('button', { name: 'Pixel difference' }), {
			pressed: true
		});
		await journey.expectVisible(
			ways.byRole('img', { name: 'The pixels that changed in assets/badge.png, in magenta' })
		);
		await journey.expectText(badge, '170 of 1,536 pixels changed');
		await journey.step('Comparing pixel by pixel');

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
		// Every image is compared the same way: what only the larger covers has changed.
		await journey.expectText(banner, '896 of 1,536 pixels changed');
		await journey.step('An image that changed size');

		// Back to side by side, for every image.
		await journey.press('i');
		await journey.expectState(journey.within(banner).byRole('button', { name: 'Side by side' }), {
			pressed: true
		});

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
		// r went on to the next image waiting, the deleted one.
		await journey.expectFocused(
			journey.byRole('button', { name: 'assets/old-icon.png', exact: true })
		);
		await journey.step('An image marked as reviewed');

		// A renamed image whose bytes did not change: no pixel changed, and the page says why.
		await journey.press('j');
		const seal = journey.byRole('article', { name: 'assets/seal.png' });
		await journey.expectFocused(journey.byRole('button', { name: 'assets/seal.png', exact: true }));
		for (let n = 0; n < 3; n += 1) await journey.press('i');
		await journey.expectText(
			seal,
			"No pixels changed: the file's bytes are the same before and after."
		);
	});
});
