/**
 * A scripted categorisation: the calls an agent makes to sort a small diff from
 * nothing sorted to everything sorted, through any MCP session (`mcp-client.ts`),
 * recorded call by call with the answers as the agent read them. The repository
 * it sorts is `buildShop`'s, which has one of each thing a real diff has: a file
 * split across two sections, a test given its role, fixture data ignored with a
 * reason, a file made executable (a change to the file itself beside its
 * lines), a pure rename, a lockfile ignored automatically, a cross-reference and
 * an overview.
 *
 * The integration tests run it through the stdio shim; a journey can run it
 * against the journey's own daemon, and later packages compare recorded agent
 * sessions with it.
 */
import type { GitRepo } from './git-repo.ts';
import { reportIn, versionIn, type McpSession, type ToolAnswer } from './mcp-client.ts';

/**
 * The shop's repository: committed, then changed in the working tree. Self-contained,
 * as a fixture's build must be (`defineFixture` keys it by its source).
 */
export async function buildShop(repo: GitRepo): Promise<void> {
	const lines = (...text: readonly string[]): string => `${text.join('\n')}\n`;
	const pricing = [
		'export function price(cents: number): number {',
		'\treturn cents;',
		'}',
		'',
		'export function label(cents: number): string {',
		'\tconst whole = Math.floor(cents / 100);',
		'\tconst rest = cents % 100;',
		"\tconst padded = String(rest).padStart(2, '0');",
		'\tconst text = `${whole}.${padded}`;',
		"\tconst sign = cents < 0 ? '-' : '';",
		'\treturn `${sign}${text}`;',
		'}',
		'',
		'export function discount(cents: number): number {',
		'\treturn cents;',
		'}'
	];
	await repo.write('src/pricing.ts', lines(...pricing));
	await repo.write(
		'src/cart.ts',
		lines(
			"import { price } from './pricing.ts';",
			'',
			'export function total(items: number[]): number {',
			'\treturn items.reduce((sum, item) => sum + price(item), 0);',
			'}'
		)
	);
	await repo.write(
		'src/pricing.test.ts',
		lines(
			"import { expect, it } from 'vitest';",
			"import { price } from './pricing.ts';",
			'',
			"it('keeps a price', () => {",
			'\texpect(price(100)).toBe(100);',
			'});'
		)
	);
	await repo.write('scripts/deploy.sh', lines('#!/bin/sh', 'echo deploying'));
	await repo.write('fixtures/recorded.json', lines('{ "status": 200, "body": "first" }'));
	await repo.write('docs/guide.md', lines('# Guide', '', 'How to run the shop.'));
	await repo.commit('the shop');

	const rounded = pricing.map((line, i) =>
		i === 1
			? '\treturn Math.ceil(cents / 5) * 5;'
			: i === 13
				? 'export function discount(cents: number, percent: number): number {'
				: i === 14
					? '\treturn cents - Math.round((cents * percent) / 100);'
					: line
	);
	await repo.write('src/pricing.ts', lines(...rounded));
	await repo.write(
		'src/cart.ts',
		lines(
			"import { discount, price } from './pricing.ts';",
			'',
			'export function total(items: number[], percent = 0): number {',
			'\treturn discount(items.reduce((sum, item) => sum + price(item), 0), percent);',
			'}'
		)
	);
	await repo.write(
		'src/pricing.test.ts',
		lines(
			"import { expect, it } from 'vitest';",
			"import { price } from './pricing.ts';",
			'',
			"it('rounds a price up to five cents', () => {",
			'\texpect(price(101)).toBe(105);',
			'});'
		)
	);
	await repo.write('scripts/deploy.sh', lines('#!/bin/sh', 'echo deploying', 'echo done'));
	await repo.setExecutable('scripts/deploy.sh', true);
	await repo.write('fixtures/recorded.json', lines('{ "status": 200, "body": "second" }'));
	await repo.move('docs/guide.md', 'docs/handbook.md');
	await repo.write('package-lock.json', lines('{ "lockfileVersion": 3 }'));
}

/** One call of the script and what it answered. */
export interface RecordedCall {
	readonly tool: string;
	readonly args: Readonly<Record<string, unknown>>;
	readonly answer: ToolAnswer;
}

export interface Categorised {
	readonly report: string;
	readonly calls: readonly RecordedCall[];
}

/** The shop's lines, as get_diff labels them, that the script names. */
export const SHOP_LINES = {
	/** The new rounding in price(). */
	rounding: 'h1',
	/** The new discount(), both sides. */
	discount: '-14..-15,+14..+15',
	/** Where cart.ts calls price(), which the rounding section points to. */
	cartUsesPrice: '+4',
	/** The new line of deploy.sh, with the change to the file itself. */
	deploy: 'file,+3'
} as const;

/**
 * Runs the script on the shop's working tree and records every call. Each write
 * sends the version the last reading answer gave, as an agent must.
 */
export async function categoriseShop(
	session: McpSession,
	options: { readonly directory?: string } = {}
): Promise<Categorised> {
	const answer = await session.call('create_report', {
		source: 'working-tree',
		...(options.directory === undefined ? {} : { directory: options.directory })
	});
	const created: RecordedCall = {
		tool: 'create_report',
		args: {
			source: 'working-tree',
			...(options.directory === undefined ? {} : { directory: options.directory })
		},
		answer
	};
	if (answer.refused) throw new Error(`create_report was refused: ${answer.text}`);
	const sorted = await sortShop(session, reportIn(answer));
	return { report: sorted.report, calls: [created, ...sorted.calls] };
}

/**
 * Sorts a report of the shop's working tree that exists already, given only
 * its id, as an agent does that a person asked to sort the Delve they have
 * open: it creates nothing, and begins with the manifest.
 */
export async function sortShop(session: McpSession, report: string): Promise<Categorised> {
	const calls: RecordedCall[] = [];
	const call = async (
		tool: string,
		args: Readonly<Record<string, unknown>>
	): Promise<ToolAnswer> => {
		const answer = await session.call(tool, args);
		calls.push({ tool, args, answer });
		if (answer.refused) throw new Error(`${tool} was refused: ${answer.text}`);
		return answer;
	};
	const manifest = await call('get_manifest', { report });
	const version = versionIn(manifest);
	await call('get_diff', { report });
	await call('upsert_sections', {
		report,
		version,
		sections: [
			{
				id: 'rounding',
				title: 'Prices round up to five cents',
				summary: 'price() rounds up to the next five cents, and its test says so.',
				references: [{ file: 'src/cart.ts', lines: SHOP_LINES.cartUsesPrice }]
			},
			{
				id: 'discounts',
				title: 'A cart total can take a discount',
				summary: 'discount() takes a percentage, and total() passes one through.'
			},
			{ id: 'housekeeping', title: 'Deploy script and docs' }
		]
	});
	await call('assign', {
		report,
		version,
		items: [
			{ file: 'src/pricing.ts', hunks: [SHOP_LINES.rounding], section: 'rounding' },
			{ file: 'src/pricing.ts', lines: SHOP_LINES.discount, section: 'discounts' },
			{ file: 'src/cart.ts', section: 'discounts' },
			{ file: 'src/pricing.test.ts', section: 'rounding', role: 'test' },
			{ file: 'scripts/deploy.sh', lines: SHOP_LINES.deploy, section: 'housekeeping' },
			{ glob: 'fixtures/**', section: 'ignored', reason: 'Re-recorded HTTP fixture data.' }
		]
	});
	await call('get_coverage', { report });
	await call('assign', {
		report,
		version,
		items: [{ file: 'docs/handbook.md', section: 'housekeeping' }]
	});
	await call('upsert_sections', {
		report,
		version,
		sections: [
			{
				id: 'housekeeping',
				summary: 'deploy.sh is now executable and says when it is done; the guide is renamed.'
			}
		]
	});
	await call('set_overview', {
		report,
		version,
		markdown:
			'Prices now round up to five cents (**rounding**), and a cart total can take a discount (**discounts**). The rest is housekeeping.'
	});
	await call('get_coverage', { report });
	return { report, calls };
}

/** A recorded session as text, call by call, for a person to read. */
export function transcriptOf(calls: readonly RecordedCall[]): string {
	return calls
		.map(
			(c) =>
				`### ${c.tool} ${JSON.stringify(c.args)}\n${c.answer.refused ? '(refused)\n' : ''}${c.answer.text}`
		)
		.join('\n\n');
}
