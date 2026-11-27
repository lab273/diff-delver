import { expect, test } from '../support/journey.ts';

// J7 Ask for more context: from a line, the menu offers Ask, and `q` opens the
// one Ask box, with "Explain this" and "Show me related code" ready-made. With
// no agent connected, the question says so and is copied as a prompt; an
// agent listening with wait_for_requests takes it, and its answer appears
// beside the line, marked as the agent's, with the code it pointed at drawn by
// diff delver. A question about the whole file goes to the connected agent at
// once. Keyboard only.
test.describe('J7 Ask for more context', () => {
	test('the reviewer asks about a line, copies it as a prompt, reads the answer, and asks about the file', async ({
		journey
	}) => {
		const shop = await journey.repository('shop');
		const opened = await journey.command([], shop);
		const report = new URL(opened.address).pathname.split('/').at(-1) ?? '';
		await journey.open(opened.address);

		const discount = journey.within(journey.byRole('article', { name: 'src/discount.ts' }));
		const line = (number: number) =>
			discount.byRole('button', {
				name: `Comment on, flag or ask about line ${String(number)}, after`,
				exact: true
			});

		// To the discount file, and to its fourth line.
		await journey.press('j');
		await journey.press('j');
		await journey.press('j');
		await journey.expectFocused(
			discount.byRole('button', { name: 'src/discount.ts', exact: true })
		);
		await journey.press('q');
		await journey.expectFocused(line(1));
		await journey.press('ArrowDown');
		await journey.press('ArrowDown');
		await journey.press('ArrowDown');
		await journey.expectFocused(line(4));

		// The line's menu offers Ask beside Comment and Flag.
		await journey.press('Enter');
		const menu = journey.within(
			discount.byRole('group', { name: 'After, line 4: comment, flag or ask' })
		);
		await journey.expectVisible(
			menu.byRole('button', { name: 'Ask the agent about After, line 4' })
		);
		await journey.press('Escape');
		await journey.expectFocused(line(4));

		// `q` opens the Ask box, which says no agent is connected.
		await journey.press('q');
		const box = journey.within(discount.byRole('form', { name: 'Ask the agent' }));
		await journey.expectFocused(box.byRole('button', { name: 'Explain this', exact: true }));
		await journey.expectVisible(
			box.byText('No agent connected: your question waits here', { exact: false })
		);
		await journey.step('The Ask box under a line');

		// "Explain this" asks at once; with no agent, the question says so and copies as a prompt.
		await journey.press('Enter');
		const question = discount.byRole('article', {
			name: 'Question for the agent about After, line 4'
		});
		const asked = journey.within(question);
		await journey.expectFocused(question);
		await journey.expectVisible(asked.byText('Not sent yet: no agent is connected'));
		await journey.expectVisible(
			asked.byText('No agent connected. Copy this request and paste it into your agent.')
		);
		await journey.activate(asked.byRole('button', { name: 'Copy as prompt' }));
		await journey.expectVisible(asked.byText('Copied. Paste it into your agent', { exact: false }));
		const prompt = await journey.readClipboard();
		expect(prompt).toContain(`In diff delver report ${report} (`);
		expect(prompt).toContain(
			'asks about src/discount.ts, lines +4 (the new side): “Explain this.”'
		);
		expect(prompt).toContain('answer with answer_request for request 1');
		await journey.step('A question copied as a prompt');

		// An agent listens: it takes the question and answers, pointing at code by its lines.
		const waited = await journey.agentCall('wait_for_requests', { report, timeout: 1 });
		expect(waited).toContain('Request 1, about src/discount.ts, lines +4 (the new side)');
		await journey.agentCall('answer_request', {
			request: 1,
			body: 'A code that is not in `CODES` gives no discount: `?? 0` makes its rate 0, and nothing says so. The codes are fixed on line 1, and the cart passes the code on as it was typed.',
			references: [
				{ file: 'src/discount.ts', lines: '+1' },
				{ file: 'src/cart.ts', lines: '+4..+6' }
			]
		});
		await journey.returnToPage();
		await journey.expectVisible(asked.byText('Answered', { exact: true }));
		const answer = journey.within(asked.byRole('region', { name: 'The agent’s answer' }));
		await journey.expectVisible(answer.byText('makes its rate 0', { exact: false }));
		await journey.expectVisible(answer.byText('src/cart.ts, After, lines 4–6'));
		await journey.expectVisible(
			answer.byText('return code === undefined ? sum : discount(sum, code);', { exact: false })
		);
		await journey.expectHidden(asked.byRole('button', { name: 'Copy as prompt' }));
		await journey.step('The agent’s answer with its code');

		// With the agent connected, a question about the whole file goes to it at once.
		await journey.activate(line(4), 'q');
		await journey.expectVisible(
			box.byText('Agent connected: it gets your question at once', { exact: false })
		);
		await journey.press('Shift+Tab');
		await journey.expectFocused(box.byRole('radio', { name: 'After, line 4' }));
		await journey.press('ArrowDown');
		await journey.expectState(box.byRole('radio', { name: 'The whole file' }), { checked: true });
		await journey.activate(box.byRole('button', { name: 'Show me related code', exact: true }));
		const aboutFile = discount.byRole('article', {
			name: 'Question for the agent about the whole file'
		});
		await journey.expectFocused(aboutFile);
		await journey.expectVisible(journey.within(aboutFile).byText('Waiting for the agent'));
		await journey.step('A question about the whole file');

		// A question being written is kept while its lines are not on the page, and listed
		// in the draft at the foot of the page, where it can be discarded.
		await journey.activate(line(4), 'q');
		await journey.press('Tab');
		await journey.press('Tab');
		await journey.expectFocused(box.byRole('textbox', { name: 'Or ask in your own words' }));
		await journey.type('Is a code ever upper case?');
		await journey.activate(journey.byRole('button', { name: 'By file' }));
		await journey.activate(journey.byRole('button', { name: 'Your draft review', exact: true }));
		const notAsked = journey.within(
			journey.byRole('list', { name: 'Questions for the agent not asked yet' })
		);
		await journey.expectVisible(notAsked.byText('Is a code ever upper case?', { exact: false }));
		await journey.activate(
			notAsked.byRole('button', {
				name: 'Discard the question not asked yet on src/discount.ts, After, line 4'
			})
		);
		await journey.expectHidden(
			journey.byRole('list', { name: 'Questions for the agent not asked yet' })
		);
	});
});
