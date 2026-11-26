/**
 * `set_reading_order` (DESIGN 4.3.1, 7.1) as an agent meets it, over the
 * daemon's `/mcp`: a section's steps are set, a file split over two of them,
 * refused when a step is outside the section or the version has moved on,
 * read back from the manifest, and carried to the next version with the lines
 * they name.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { testDaemon } from '../../../../tests/support/daemons.ts';
import {
	defineFixture,
	tempDirectory,
	useFixture
} from '../../../../tests/support/fixture-repos.ts';
import { mcpOverHttp } from '../../../../tests/support/mcp-client.ts';
import { buildShop, categoriseShop } from '../../../../tests/support/scripted-categorisation.ts';

const shop = defineFixture('reading-order-shop', buildShop);

/** Discounts: the new discount() first, then the cart total that takes it, then cart.ts's import. */
const STEPS = [
	{ file: 'src/pricing.ts', note: 'The new discount(), which total() calls.' },
	{ file: 'src/cart.ts', lines: '-3..-4,+3..+4', note: 'total() takes a percentage.' },
	{ file: 'src/cart.ts' }
];

describe('a section’s reading order, through the MCP server', () => {
	it('sets steps, refuses a wrong one or an old version, reads them back and carries them over', async () => {
		const repo = await useFixture(shop);
		const daemon = await testDaemon({ dataDirectory: await tempDirectory() });
		const session = await mcpOverHttp({
			origin: daemon.origin,
			token: daemon.mcpToken,
			directory: repo.dir
		});
		onTestFinished(() => session.close());
		const { report } = await categoriseShop(session);

		const outside = await session.call('set_reading_order', {
			report,
			version: 1,
			section: 'discounts',
			steps: [...STEPS, { file: 'docs/handbook.md' }]
		});
		expect(outside.refused).toBe(true);
		expect(outside.text).toContain(
			'- Step 3: none of the changes it names in "docs/handbook.md" are in discounts.'
		);

		const set = await session.call('set_reading_order', {
			report,
			version: 1,
			section: 'discounts',
			steps: STEPS
		});
		expect(set.refused).toBe(false);
		expect(set.text).toContain('discounts is read in 3 steps');
		expect(set.text).toContain(
			'1. src/pricing.ts -14..-15,+14..+15 (4 change lines); note "The new discount(), which total() calls."'
		);
		expect(set.text).toContain('3. src/cart.ts -1,+1 (2 change lines)');
		expect(set.text).toContain('Every change line of the section is in a step.');
		const again = await session.call('set_reading_order', {
			report,
			version: 1,
			section: 'discounts',
			steps: STEPS
		});
		expect(again.text).toBe(set.text);

		const manifest = await session.call('get_manifest', { report });
		// Every line of the section is in a step, so nothing follows them.
		expect(manifest.text).toMatch(/^ {2}discounts: .*, read in 3 steps$/m);
		expect(manifest.text).toContain(
			'    2. src/cart.ts -3..-4,+3..+4 (4 change lines); note "total() takes a percentage."'
		);

		// The import changes again: its new line is new and goes unsorted, its old one keeps its step.
		await repo.write(
			'src/cart.ts',
			[
				"import { discount, price } from './pricing';",
				'',
				'export function total(items: number[], percent = 0): number {',
				'\treturn discount(items.reduce((sum, item) => sum + price(item), 0), percent);',
				'}',
				''
			].join('\n')
		);
		await session.call('create_report', { source: 'working-tree' });
		const late = await session.call('set_reading_order', {
			report,
			version: 1,
			section: 'discounts',
			steps: []
		});
		expect(late.refused).toBe(true);
		expect(late.text).toMatch(/^The diff changed since you read it: you sent "version": 1/);
		const carried = await session.call('get_manifest', { report });
		expect(carried.text).toContain('version 2.');
		expect(carried.text).toContain('    3. src/cart.ts -1 (1 change line)');

		const cleared = await session.call('set_reading_order', {
			report,
			version: 2,
			section: 'discounts',
			steps: []
		});
		expect(cleared.text).toContain('discounts has no reading order now');
		expect((await session.call('get_manifest', { report })).text).not.toContain('read in');
	});
});
