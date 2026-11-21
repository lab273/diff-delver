import { test } from '../support/journey.ts';

test.describe('J18 Draft comments', () => {
	test('the reviewer selects a range and keeps unsaved text while a newer version appears', async ({
		journey
	}) => {
		const reading = await journey.repository('reading');
		await journey.open((await journey.command([], reading)).address);
		const lexer = journey.byRole('article', { name: 'src/lexer.ts' });
		const file = journey.within(lexer);
		const toggle = file.byRole('button', { name: 'src/lexer.ts', exact: true });
		const expand = file.byRole('button', { name: 'Show all 8 unchanged lines above' });
		const comment = file.byRole('button', { name: 'Comment on lines', exact: true });
		const beforeOne = file.byRole('button', { name: 'Before, line 1', exact: true });
		const beforeTwo = file.byRole('button', { name: 'Before, line 2', exact: true });
		const reviewed = file.byRole('checkbox', { name: 'Reviewed: src/lexer.ts' });
		const unreadOnly = journey.byRole('button', { name: 'Only what I have not reviewed' });
		const afterOne = file.byRole('button', { name: 'After, line 1', exact: true });
		const form = journey.within(journey.byRole('form', { name: 'Unsaved comment' }));
		const body = form.byRole('textbox', { name: 'Comment', exact: true });
		const save = form.byRole('button', { name: 'Save draft comment' });

		await journey.activate(expand);
		await journey.activate(comment);
		await journey.expectFocused(beforeOne);
		await journey.press('Shift+ArrowDown');
		await journey.expectFocused(beforeTwo);
		await journey.expectState(beforeOne, { pressed: true });
		await journey.expectState(beforeTwo, { pressed: true });
		await journey.step('Two lines selected in the gutter');

		await journey.press('Enter');
		await journey.expectFocused(body);
		await journey.type('Can we shorten this introduction?');
		await journey.activate(toggle);
		await journey.expectState(toggle, { expanded: false });
		await journey.expectVisible(form.byText('Before, lines 1–2'));
		await journey.activate(reviewed, 'Space');
		await journey.activate(unreadOnly);
		await journey.expectState(unreadOnly, { pressed: true });
		await journey.expectVisible(form.byText('Before, lines 1–2'));
		await journey.activate(save);
		await journey.expectVisible(journey.byText('Draft comment saved.'));

		await journey.activate(unreadOnly);
		await journey.activate(reviewed, 'Space');
		await journey.expectState(toggle, { expanded: true });
		await journey.activate(comment);
		await journey.press('ArrowRight');
		await journey.expectFocused(afterOne);
		await journey.press('Enter');
		await journey.expectFocused(body);
		await journey.type('Keep the heading on the after side.');

		// Another command brings the Delve up to date while this tab still shows version 1.
		await journey.editFile(reading, 'src/comment-follow-up.ts', 'export const heading = "Shop";\n');
		const newer = await journey.command([], reading);
		await journey.activate(save);
		await journey.expectText(form.byRole('alert'), 'updated to version 2');
		await journey.step('A stale save keeps the comment', {
			refusals: [{ route: '/api/diffs/[id]/comments', status: 409 }]
		});
		await journey.activate(form.byRole('button', { name: 'Show newer version', exact: true }));
		await journey.expectVisible(form.byText('These lines are from an earlier version'));
		await journey.expectVisible(form.byText('After, line 1'));
		await journey.expectState(save, { disabled: true });
		await journey.activate(form.byRole('button', { name: 'Choose new lines' }));
		await journey.press('s');
		await journey.activate(expand);
		await journey.activate(comment);
		await journey.press('ArrowRight');
		await journey.expectFocused(afterOne);
		await journey.press('Enter');
		await journey.expectFocused(body);
		await journey.expectVisible(form.byText('Version 2'));
		await journey.activate(save);
		await journey.expectVisible(journey.byText('Draft comment saved.'));

		await journey.open(newer.address);
		await journey.activate(journey.byRole('button', { name: 'Draft comments', exact: true }));
		await journey.expectVisible(journey.byText('Can we shorten this introduction?'));
		await journey.expectVisible(journey.byText('Before, lines 1–2'));
		await journey.expectVisible(journey.byText('Earlier version 1'));
		await journey.expectVisible(journey.byText('Keep the heading on the after side.'));
		await journey.expectVisible(journey.byText('After, line 1'));
		await journey.step('Draft comments after reopening');

		const drafts = journey.byRole('button', { name: 'Draft comments', exact: true });
		await journey.activate(expand);
		await journey.activate(comment);
		await journey.press('Enter');
		await journey.expectFocused(body);
		await journey.type('Discard this text.');
		await journey.activate(form.byRole('button', { name: 'Discard unsaved comment' }));
		await journey.expectFocused(drafts);
		await journey.activate(drafts);
		await journey.expectState(drafts, { expanded: false });
	});
});
