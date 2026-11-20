/**
 * What lint forbids in journey files (scripts/eslint-journey-rules.ts), run on
 * planted journeys. Each was a way to reach the page without the keyboard that a
 * lint-clean journey once used.
 */
import { Linter } from 'eslint';
import ts from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { JOURNEY_RESTRICTED_SYNTAX } from './eslint-journey-rules.ts';

const linter = new Linter({ configType: 'flat' });

function problems(body: string): readonly string[] {
	const code = `import { test } from '../support/journey.ts';\ntest('x', async ({ journey }) => {\n${body}\n});\n`;
	return linter
		.verify(
			code,
			[
				{
					files: ['**/*.ts'],
					languageOptions: { parser: ts.parser },
					rules: { 'no-restricted-syntax': ['error', ...JOURNEY_RESTRICTED_SYNTAX] }
				}
			],
			'tests/journeys/j9-planted.journey.ts'
		)
		.map((m) => m.message);
}

describe('the journey lint rules', () => {
	it.each([
		[
			'a click through a script',
			'await target.evaluate((el) => HTMLElement.prototype.click.call(el));'
		],
		['a value set in the page', "await handle.evaluate((el) => { el.value = 'x'; });"],
		['evaluateHandle', 'await page.evaluateHandle(() => document.body);'],
		['$eval', "await page.$eval('input', (el) => el.remove());"],
		['$$eval', "await page.$$eval('input', (els) => els.length);"],
		['setContent', "await page.setContent('<p>x</p>');"],
		['addScriptTag', "await page.addScriptTag({ content: 'x()' });"],
		['addInitScript', 'await page.addInitScript(() => undefined);'],
		['exposeFunction', "await page.exposeFunction('f', () => 1);"],
		['a route', "await page.route('**', (r) => r.abort());"],
		['the page through a target', 'const p = journey.page;'],
		['a locator', "const l = journey.locator('input');"],
		['a computed property', "const p = journey['page'];"],
		['a computed property by name', 'const name = "page"; const p = journey[name];'],
		['Reflect', "const p: unknown = Reflect.get(journey, 'page');"],
		['a click', 'await target.click();'],
		['dispatchEvent', "await target.dispatchEvent('click');"],
		['the mouse', 'await keyboardless.mouse.click(1, 2);'],
		['test.extend', 'test.extend({});']
	])('forbids %s', (_name, body) => {
		expect(problems(body)).not.toEqual([]);
	});

	it('forbids taking any fixture but the journey', () => {
		const code =
			"import { test } from '../support/journey.ts';\ntest('x', async ({ journey, page }) => {});\n";
		const found = linter
			.verify(
				code,
				[
					{
						files: ['**/*.ts'],
						languageOptions: { parser: ts.parser },
						rules: { 'no-restricted-syntax': ['error', ...JOURNEY_RESTRICTED_SYNTAX] }
					}
				],
				'tests/journeys/j9-planted.journey.ts'
			)
			.map((m) => m.message);
		expect(found.join('\n')).toContain('takes only the journey fixture');
	});

	it('allows a journey written with the helper', () => {
		expect(
			problems(
				[
					"await journey.open('/');",
					"await journey.activate(journey.byRole('button', { name: 'Go' }));",
					"await journey.type('hello');",
					"await journey.press('Tab');",
					'const order = await journey.tabOrder();',
					'const first = order[0];',
					"await journey.step('Start page');"
				].join('\n')
			)
		).toEqual([]);
	});
});
