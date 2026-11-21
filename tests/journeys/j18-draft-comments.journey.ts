import { test } from '../support/journey.ts';

test.describe('J18 Draft comments', () => {
	test('the reviewer saves a range and a single line and finds both after reopening', async ({
		journey
	}) => {
		const reading = await journey.repository('reading');
		const opened = await journey.command([], reading);
		await journey.open(opened.address);
		const file = journey.within(journey.byRole('article', { name: 'src/lexer.ts' }));
		await journey.activate(file.byRole('button', { name: 'Show all 8 unchanged lines above' }));
		const comment = file.byRole('button', { name: 'Comment on lines', exact: true });
		await journey.activate(comment);
		await journey.activate(
			file.byRole('button', { name: 'Comment on line 1 before', exact: true })
		);
		const body = file.byRole('textbox', { name: 'Comment', exact: true });
		await journey.expectFocused(body);
		await journey.type('Can we shorten this introduction?');
		const end = file.byRole('spinbutton', { name: 'Last line (optional)' });
		await journey.tabTo(end);
		await journey.type('9999');
		const save = file.byRole('button', { name: 'Save draft comment' });
		await journey.activate(save);
		await journey.expectText(file.byRole('alert'), 'Those lines are unavailable on that side');
		await journey.step('The range is unavailable', {
			refusals: [{ route: '/api/diffs/[id]/comments', status: 422 }]
		});

		await journey.tabTo(end);
		await journey.press('Control+a');
		await journey.type('2');
		await journey.activate(save);
		await journey.expectVisible(file.byText('Draft comment saved.'));
		await journey.expectFocused(comment);

		await journey.press('s');
		await journey.activate(comment);
		await journey.activate(file.byRole('button', { name: 'Comment on line 1 after', exact: true }));
		await journey.expectFocused(body);
		await journey.type('Keep the heading on the after side.');
		await journey.activate(save);
		await journey.expectVisible(file.byText('Draft comment saved.'));

		const again = await journey.command([], reading);
		await journey.open(again.address);
		await journey.activate(journey.byRole('button', { name: 'Draft comments', exact: true }));
		await journey.expectVisible(journey.byText('Can we shorten this introduction?'));
		await journey.expectVisible(journey.byText('Before, lines 1–2'));
		await journey.expectVisible(journey.byText('Keep the heading on the after side.'));
		await journey.expectVisible(journey.byText('After, line 1'));
		await journey.step('Draft comments after reopening');
	});
});
