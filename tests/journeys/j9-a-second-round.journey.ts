import { expect, test } from '../support/journey.ts';

/** The discount as the agent leaves it after review 1: its fourth line rewritten. */
const DISCOUNT_FIXED = [
	'const CODES: Record<string, number> = { SPRING: 0.1, LOYAL: 0.15 };',
	'',
	'export function discount(sum: number, code: string): number {',
	'\treturn code in CODES ? sum * (1 - (CODES[code] ?? 0)) : sum;',
	'}'
];

// J9 A second round: the reviewer finishes review 1 with two comments, the
// agent rewrites one of the commented lines, and after the update the page
// shows both comments at their lines, one open and one whose code changed
// since. The reviewer replies to the open one and resolves the other, finishes
// review 2, and the text copied lists what is still open, with the reply, and
// what was resolved. Keyboard only.
test.describe('J9 A second round', () => {
	test('the reviewer sees earlier comments open or changed, replies, resolves and finishes review 2', async ({
		journey
	}) => {
		const shop = await journey.repository('shop');
		const opened = await journey.command([], shop);
		await journey.open(opened.address);
		const discount = journey.within(journey.byRole('article', { name: 'src/discount.ts' }));
		const finish = journey.within(journey.byRole('region', { name: 'Finish your review' }));
		const finishAndCopy = finish.byRole('button', { name: 'Finish and copy', exact: true });

		// Review 1: a comment on the codes, and one on the line that applies them.
		const lineButton = (line: number) =>
			discount.byRole('button', {
				name: `Comment on, flag or ask about line ${String(line)}, after`,
				exact: true
			});
		for (const [line, words] of [
			[1, 'Should the codes come from settings?'],
			[4, 'What happens with a code nobody knows?']
		] as const) {
			// The file's line numbers are one stop for Tab; the arrow keys move between them.
			await journey.tabTo(lineButton(1));
			for (let at = 1; at < line; at += 1) await journey.press('ArrowDown');
			await journey.expectFocused(lineButton(line));
			await journey.press('Enter');
			await journey.activate(
				journey.byRole('button', { name: `Comment on After, line ${String(line)}`, exact: true })
			);
			const box = journey.within(
				journey.byRole('form', { name: `New comment on After, line ${String(line)}`, exact: true })
			);
			await journey.expectFocused(box.byRole('textbox', { name: 'Comment', exact: true }));
			await journey.type(words);
			await journey.press('Control+Enter');
			await journey.expectVisible(discount.byText(words, { exact: true }));
		}
		await journey.activate(finishAndCopy);
		await journey.expectVisible(
			finish.byText('Review 1 is finished and copied.', { exact: false })
		);

		// The agent rewrites the line the second comment is on; the reviewer updates.
		await journey.editFile(shop, 'src/discount.ts', `${DISCOUNT_FIXED.join('\n')}\n`);
		await journey.returnToPage();
		const changed = journey.byRole('region', { name: 'Your files have changed' });
		await journey.activate(journey.within(changed).byRole('button', { name: 'Update' }));
		await journey.expectFocused(
			journey.byRole('heading', { name: 'Updated to version 2 just now' })
		);
		const earlier = journey.byRole('region', {
			name: 'From earlier reviews: 1 open, 1 code changed since'
		});
		await journey.expectVisible(earlier);
		const settings = journey.byRole('article', {
			name: 'Comment from review 1, Open, on After, line 1'
		});
		const unknown = journey.byRole('article', {
			name: 'Comment from review 1, Code changed since, on After, line 4'
		});
		await journey.expectVisible(settings);
		await journey.expectVisible(unknown);
		await journey.step('Earlier comments, one open and one changed since');

		// `p` goes to the first one open, which the reviewer replies to.
		await journey.press('p');
		await journey.expectFocused(settings);
		await journey.activate(
			journey.within(settings).byRole('button', {
				name: 'Reply to the comment from review 1 on After, line 1',
				exact: true
			})
		);
		await journey.expectFocused(
			journey.within(settings).byRole('textbox', { name: 'Your reply', exact: true })
		);
		await journey.type('Fine for now; settings come in the next change.');
		await journey.step('Replying to an earlier comment');
		await journey.press('Control+Enter');
		await journey.expectVisible(
			journey
				.within(settings)
				.byRole('article', { name: 'Your reply on After, line 1', exact: true })
		);

		// `p` again: the one whose code changed, which the reviewer resolves.
		await journey.press('p');
		await journey.expectFocused(unknown);
		await journey.activate(
			journey.within(unknown).byRole('button', {
				name: 'Resolve the comment from review 1 on After, line 4',
				exact: true
			})
		);
		const resolved = journey.byRole('article', {
			name: 'Comment from review 1, Resolved in this review, on After, line 4'
		});
		await journey.expectVisible(resolved);
		await journey.step('A reply and a resolution in the draft');

		await journey.activate(finishAndCopy);
		await journey.expectVisible(
			finish.byText('Review 2 is finished and copied.', { exact: false })
		);
		const copied = await journey.readClipboard();
		expect(copied).toContain(
			[
				'## Still open from earlier reviews',
				'',
				'### src/discount.ts:1 (new), from review 1, unchanged',
				'> Should the codes come from settings?',
				'Reply in this review:',
				'> Fine for now; settings come in the next change.',
				'',
				'## Resolved in this review',
				'',
				'### src/discount.ts:4 (new), from review 1, changed since',
				'> What happens with a code nobody knows?'
			].join('\n')
		);
		// The list says how they stand now: the one replied to is open, the other resolved.
		const after = journey.byRole('region', { name: 'From earlier reviews: 1 open, 1 resolved' });
		await journey.expectVisible(after);
		await journey.expectVisible(
			journey.within(after).byRole('article', {
				name: 'Comment from review 1, Resolved, on src/discount.ts, After, line 4'
			})
		);
		await journey.step('Review 2 finished');
	});
});
