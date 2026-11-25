/**
 * What a journey needs outside the browser: repositories to review and a
 * daemon of its own, as a person's machine would have them.
 *
 * - Each journey gets its own daemon, started in the Playwright worker's own
 *   process on a free port, with its own temporary data folder, a fixed clock
 *   (`JOURNEY_TIME`) and fixed ids, so its pages are the same on every run.
 *   The app is the production build (`build/handler.js`), loaded once per
 *   worker; starting a daemon on it opens a fresh database and takes a few
 *   milliseconds.
 * - Repositories are named fixtures, built once per run with real git and
 *   copied for each journey into a folder named after the fixture, so the page
 *   names the repository the same way on every machine ("shop"), whatever the
 *   temporary folder is called.
 * - The daemon is told that the journey's folder is the person's home folder
 *   and that its data folder is the machine's default, as they are for a
 *   person: a folder the page names is then named from `~`, the same on every
 *   machine, and the command it gives an agent names no data folder. The first
 *   repository of each folder name is at `~/src/<name>`.
 * - git runs with a reviewer setup of the run's own, never the machine's
 *   global config.
 *
 * The run's folder is made by the journeys' global setup and named in
 * `JOURNEY_ROOT_VARIABLE`.
 */
import { randomUUID } from 'node:crypto';
import { access, cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiClient } from '../../src/lib/api/client.ts';
import { parseCommandLine, describeCommandLineError } from '../../src/lib/core/cli/command-line.ts';
import { settableClock } from '../../src/lib/core/clock.ts';
import { parseCodeVersion } from '../../src/lib/core/code-version.tiny.ts';
import { sequentialIds } from '../../src/lib/core/ids.ts';
import { parseTimestamp } from '../../src/lib/core/timestamp.tiny.ts';
import { chooseOutcome, openOutcome, startOutcome } from '../../src/lib/server/cli/outcome.ts';
import { loadAppHandler, type AppHandler } from '../../src/lib/server/daemon/app-handler.ts';
import {
	describeDaemonStartError,
	entryAddress,
	startDaemon,
	type RunningDaemon
} from '../../src/lib/server/daemon/daemon.ts';
import { committedRecording, replay } from '../agent-trials/replay.ts';
import { normaliser } from '../agent-trials/recording.ts';
import { absolutePath, defineFixture, GitRepo, type Fixture } from './git-repo.ts';
import { buildImages } from './image-fixtures.ts';
import { buildLedger } from './ledger.ts';
import { mcpOverHttp } from './mcp-client.ts';
import { buildShop } from './scripted-categorisation.ts';

/** The variable naming the run's folder, which the global setup makes and removes. */
export const JOURNEY_ROOT_VARIABLE = 'DIFF_DELVER_JOURNEY_ROOT';

/** The time on every journey's clocks, the browser's and the daemon's. */
export const JOURNEY_TIME = new Date('2026-01-15T09:30:00Z');

function root(): string {
	const dir = process.env[JOURNEY_ROOT_VARIABLE];
	if (dir === undefined) {
		throw new Error(`${JOURNEY_ROOT_VARIABLE} is not set: run journeys with playwright test.`);
	}
	return dir;
}

const lines = (...text: readonly string[]): string => `${text.join('\n')}\n`;

/** The shop's checkout, 45 lines long: long enough to have unchanged lines to open, a step at a time below the change. */
const CHECKOUT = [
	"import { total } from './cart.ts';",
	'',
	'export interface Order {',
	'\treadonly items: readonly number[];',
	'\treadonly code?: string;',
	'\treadonly address: string;',
	'}',
	'',
	'export function validate(order: Order): string[] {',
	'\tconst problems: string[] = [];',
	"\tif (order.items.length === 0) problems.push('The basket is empty.');",
	"\tif (order.address.trim() === '') problems.push('There is no address.');",
	'\treturn problems;',
	'}',
	'',
	'export function summary(order: Order): string {',
	'\tconst count = order.items.length;',
	"\tconst items = count === 1 ? '1 item' : `${count} items`;",
	'\tconst sum = total(order.items, order.code);',
	'\treturn `${items}, ${sum.toFixed(2)}`;',
	'}',
	'',
	'export function receipt(order: Order): string[] {',
	'\treturn [',
	"\t\t'Thank you for your order.',",
	'\t\tsummary(order),',
	'\t\t`Sent to ${order.address}`',
	'\t];',
	'}',
	'',
	'export function canPay(order: Order): boolean {',
	'\treturn validate(order).length === 0;',
	'}',
	'',
	'export function pay(order: Order): string[] {',
	'\tif (!canPay(order)) return validate(order);',
	"\tconsole.log('Paying', summary(order));",
	'\treturn receipt(order);',
	'}',
	'',
	'export function refund(order: Order): string {',
	'\treturn `Refunded: ${summary(order)}`;',
	'}',
	'// End of checkout.'
];

/**
 * The changes of `src/pairs.ts` in the reading repository, for side by side: two
 * lines replaced by three (two beside two, one beside nothing), a line removed
 * with nothing in its place, and a line added where there was none.
 */
const PAIRS_BEFORE = {
	at5: ['export const price5 = 50;', 'export const price6 = 60;'],
	at20: ['export const price20 = 200;'],
	at35: ['export const price35 = 350;']
} as const;
const PAIRS_AFTER = {
	at5: [
		'export const price5 = 55; // rounded up',
		'export const price6 = 65; // rounded up',
		'export const price6Note = "was 60";'
	],
	at20: [],
	at35: ['export const price35 = 350;', 'export const price35b = 355;']
} as const;

/**
 * `tools/total.ts` in the reading repository, for hiding white-space changes:
 * a function re-indented with tabs, with one real change among the lines,
 * and further down a line whose only change is a CRLF ending.
 */
/** A workflow whose last key, `when`, belongs to `deploy` until it is moved out by its indentation alone. */
const WORKFLOW_BEFORE: readonly string[] = [
	'deploy:',
	'  steps:',
	'    - build',
	'    - test',
	'  when: manual'
];

const TOTAL_BEFORE: readonly string[] = [
	'export function total(items: number[]): number {',
	'  let sum = 0;',
	'  for (const item of items) {',
	'    sum += item;',
	'  }',
	'  return sum;',
	'}',
	...Array.from({ length: 12 }, (_, i) => `// Note ${String(i + 1)} on totals.`),
	"export const label = 'Total';",
	'// The end.'
];
const TOTAL_AFTER: readonly string[] = [
	'export function total(items: number[]): number {',
	'\tlet sum = 0;',
	'\tfor (const item of items) {',
	'\t\tsum += item;',
	'\t}',
	'\treturn Math.round(sum);',
	'}',
	...Array.from({ length: 12 }, (_, i) => `// Note ${String(i + 1)} on totals.`),
	"export const label = 'Total';\r",
	'// The end.'
];

/** The checkout as the shop's uncommitted changes leave it: the summary says when a code was used. */
export const CHECKOUT_CHANGED = CHECKOUT.flatMap((line, i) =>
	i === 19
		? [
				"\tconst saved = order.code === undefined ? '' : ` with ${order.code}`;",
				'\treturn `${items}, ${sum.toFixed(2)}${saved}`;'
			]
		: [line]
);

/** How many files the large repository changes. */
const LARGE_FILES = 2_000;

/** The repositories a journey can ask for, by name. */
export const JOURNEY_REPOSITORIES = {
	/** A committed shop, with uncommitted changes: two edits, one in a longer file, a new file and a lockfile. */
	shop: defineFixture('shop', async (repo) => {
		await repo.write('README.md', lines('# Shop', '', 'A small shop.'));
		await repo.write(
			'src/cart.ts',
			lines(
				"import { price } from './price.ts';",
				'',
				'export function total(items: readonly number[]): number {',
				'\treturn items.reduce((sum, item) => sum + price(item), 0);',
				'}'
			)
		);
		await repo.write('src/price.ts', lines('export const price = (cents: number) => cents / 100;'));
		await repo.write('pnpm-lock.yaml', lines("lockfileVersion: '9.0'", 'packages: {}'));
		await repo.write('src/checkout.ts', lines(...CHECKOUT));
		await repo.commit('A small shop');
		await repo.write('src/checkout.ts', lines(...CHECKOUT_CHANGED));
		await repo.write(
			'src/cart.ts',
			lines(
				"import { discount } from './discount.ts';",
				"import { price } from './price.ts';",
				'',
				'export function total(items: readonly number[], code?: string): number {',
				'\tconst sum = items.reduce((sum, item) => sum + price(item), 0);',
				'\treturn code === undefined ? sum : discount(sum, code);',
				'}'
			)
		);
		await repo.write(
			'src/discount.ts',
			lines(
				'const CODES: Record<string, number> = { SPRING: 0.1, LOYAL: 0.15 };',
				'',
				'export function discount(sum: number, code: string): number {',
				'\treturn sum * (1 - (CODES[code] ?? 0));',
				'}'
			)
		);
		await repo.write('pnpm-lock.yaml', lines("lockfileVersion: '9.0'", 'packages:', '  zod: {}'));
	}),

	/** On a branch two commits ahead of main, with nothing uncommitted. */
	'feature-branch': defineFixture('feature-branch', async (repo) => {
		await repo.write('src/app.ts', lines('export const name = "app";'));
		await repo.commit('Start');
		await repo.git('checkout', '--quiet', '-b', 'discounts');
		await repo.write(
			'src/app.ts',
			lines('export const name = "app";', 'export const sale = true;')
		);
		await repo.commit('Turn the sale on');
		await repo.write('src/discount.ts', lines('export const rate = 0.1;'));
		await repo.commit('Add the discount rate');
	}),

	/** On a branch ahead of both main and master, either of which could be the main branch. */
	'two-main-branches': defineFixture('two-main-branches', async (repo) => {
		await repo.write('src/app.ts', lines('export const name = "app";'));
		await repo.commit('Start');
		await repo.git('branch', 'master');
		await repo.write('docs/notes.md', lines('# Notes'));
		await repo.commit('Notes on main');
		await repo.git('checkout', '--quiet', '-b', 'discounts');
		await repo.write('src/discount.ts', lines('export const rate = 0.1;'));
		await repo.commit('Add the discount rate');
	}),

	/**
	 * Every awkward kind of change, uncommitted: a file renamed and one made
	 * executable with nothing else changed, a binary image changed, a file with
	 * tabs, trailing spaces, CRLF endings, a control character, a character that
	 * turns text round, markup, a very long line and no newline at the end, a
	 * generated data file too large to draw at once, a new file whose name is not
	 * valid UTF-8, new files whose names hold a character that turns text round
	 * and one that cannot be seen, and a lockfile.
	 */
	assorted: defineFixture('assorted', async (repo) => {
		await repo.write('src/old-name.ts', lines('export const name = "moved";'));
		await repo.write('scripts/build.sh', lines('#!/bin/sh', 'echo building'));
		await repo.write('assets/logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
		await repo.write('notes/odd.txt', lines('A note.', 'Nothing odd yet.'));
		await repo.write('package-lock.json', lines('{ "lockfileVersion": 3 }'));
		await repo.commit('Start');
		await repo.move('src/old-name.ts', 'src/new-name.ts');
		await repo.setExecutable('scripts/build.sh', true);
		await repo.write(
			'assets/logo.png',
			new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 9, 8, 7, 6, 5, 4, 3, 2, 1])
		);
		await repo.write(
			'notes/odd.txt',
			[
				'A note.\r',
				'\tIndented with a tab, and two spaces after it.  \r',
				'<b>Not bold</b> &amp; not an entity, a bell \u0007 and \u202Ereversed\u202C text.\r',
				`A very long line: ${Array.from({ length: 40 }, (_, i) => `word${String(i + 1)}`).join(' ')}.\r`,
				'No newline after this line.'
			].join('\n')
		);
		await repo.write(
			'data/prices.csv',
			lines(
				'sku,price',
				...Array.from({ length: 900 }, (_, i) => `item-${String(i + 1)},${String(i % 97)}.99`)
			)
		);
		await repo.writeRaw(
			new Uint8Array([
				...new TextEncoder().encode('notes/caf'),
				0xe9,
				...new TextEncoder().encode('.txt')
			]),
			lines('Saved by an editor that wrote its name in Latin-1.')
		);
		// Names that would read as something else if drawn as they are.
		await repo.write('notes/report\u202Etxt.exe', lines('Not an executable.'));
		await repo.write('notes/a\u200Bb.txt', lines('A zero-width space in the name.'));
		await repo.write('package-lock.json', lines('{ "lockfileVersion": 3, "packages": {} }'));
	}),

	/**
	 * Code to read, uncommitted, for colours by language: a change deep inside a
	 * TypeScript block comment, far from the line that opens it; Python, Rust and
	 * CSS changed; and a TypeScript file whose changed lines hold a tab, white
	 * space at the end, a CRLF ending and a character that cannot be seen, in a string.
	 */
	reading: defineFixture('reading', async (repo) => {
		/** Forty lines of prices, with `changed` in place of lines 5 and 6, 20 and 35. */
		const pairs = (changed: {
			readonly at5: readonly string[];
			readonly at20: readonly string[];
			readonly at35: readonly string[];
		}): string =>
			lines(
				...Array.from({ length: 40 }, (_, i): readonly string[] => {
					const n = i + 1;
					if (n === 5) return changed.at5;
					if (n === 6) return [];
					if (n === 20) return changed.at20;
					if (n === 35) return changed.at35;
					return [`export const price${String(n)} = ${String(n * 10)};`];
				}).flat()
			);
		const lexer = (rule: string): string =>
			lines(
				'/**',
				' * A small lexer for the shop’s search box.',
				' *',
				' * It reads what the shopper typed and splits it into words, so that',
				' * each word can be looked up on its own. Nothing here knows about',
				' * products or prices: that is the search index’s work.',
				' *',
				' * Rules:',
				' *   1. Words are split on white space.',
				' *   2. Upper and lower case are the same.',
				' *   3. Punctuation at either end of a word is dropped.',
				` *   4. ${rule}`,
				' *',
				' * Nothing is ever thrown: text the lexer cannot read gives no words.',
				' */',
				'export function lex(text: string): string[] {',
				'\treturn text',
				'\t\t.toLowerCase()',
				'\t\t.split(/\\s+/)',
				"\t\t.map((word) => word.replace(/^\\W+|\\W+$/g, ''))",
				'\t\t.filter((word) => word.length > 0);',
				'}'
			);
		const basket = (...add: string[]): string =>
			lines(
				'class Basket:',
				'    """Items a shopper has chosen."""',
				'',
				'    def __init__(self) -> None:',
				'        self.items: list[str] = []',
				'',
				...add
			);
		await repo.write('src/lexer.ts', lexer('Numbers are words too.'));
		await repo.write(
			'src/format-price.ts',
			'export const formatPrice = (price: number) => price.toFixed(2);\n'
		);
		await repo.write(
			'app/models.py',
			basket('    def add(self, item: str) -> None:', '        self.items.append(item)')
		);
		await repo.write(
			'src/main.rs',
			lines('fn main() {', '    let total: u32 = 3;', '    println!("{} items", total);', '}')
		);
		await repo.write('styles/site.css', lines('.price {', '\tcolor: #1f2328;', '}'));
		await repo.write(
			'src/marks.ts',
			lines(
				"export const greeting = 'hello';",
				'export function shout(text: string): string {',
				'\treturn text.toUpperCase();',
				'}'
			)
		);
		await repo.write('src/pairs.ts', pairs(PAIRS_BEFORE));
		await repo.write('tools/total.ts', lines(...TOTAL_BEFORE));
		await repo.write('tools/workflow.yml', lines(...WORKFLOW_BEFORE));
		await repo.commit('Start');
		// Only white space changes, but `when` moves out of `deploy`: in YAML that changes what it says.
		await repo.write(
			'tools/workflow.yml',
			lines(...WORKFLOW_BEFORE.map((l) => l.replace(/^ {2}when/, 'when')))
		);
		await repo.write('tools/total.ts', TOTAL_AFTER.join('\n') + '\n');
		await repo.write('src/pairs.ts', pairs(PAIRS_AFTER));
		await repo.write('src/lexer.ts', lexer('A number is a word, and keeps its digits.'));
		await repo.write(
			'app/models.py',
			basket(
				'    def add(self, item: str, count: int = 1) -> None:',
				'        # Each one is kept, so the basket can say how many.',
				'        self.items.extend([item] * count)'
			)
		);
		await repo.write(
			'src/main.rs',
			lines(
				'fn main() {',
				'    let total: u32 = 3;',
				'    let label = if total == 1 { "item" } else { "items" };',
				'    println!("{} {}", total, label);',
				'}'
			)
		);
		await repo.write(
			'styles/site.css',
			lines('.price {', '\tcolor: #1a7f37;', '\tfont-weight: 700;', '}')
		);
		await repo.write(
			'src/marks.ts',
			[
				"export const greeting = 'hel\u200Blo';\r",
				'export function shout(text: string): string {  ',
				"\treturn text.toUpperCase() + '!';",
				'}',
				''
			].join('\n')
		);
	}),

	/**
	 * A large diff, for the viewer's speed (tests/speed/): 2,000 files of 100
	 * lines, the first 50 of each rewritten and left uncommitted, so 200,000
	 * changed lines.
	 */
	large: defineFixture('large', async (repo) => {
		const name = (i: number): string =>
			`src/module-${String(Math.floor(i / 100)).padStart(2, '0')}/file-${String(i).padStart(4, '0')}.ts`;
		const numbered = (prefix: string, from: number, to: number): string =>
			Array.from({ length: to - from + 1 }, (_, i) => `${prefix} line ${String(from + i)}\n`).join(
				''
			);
		for (let i = 0; i < LARGE_FILES; i += 1) await repo.write(name(i), numbered('old', 1, 100));
		await repo.commit('base');
		for (let i = 0; i < LARGE_FILES; i += 1) {
			await repo.write(name(i), numbered('new', 1, 50) + numbered('old', 51, 100));
		}
	}),

	/**
	 * One very large change, for the viewer's speed (tests/speed/): a file of
	 * 40,000 lines rewritten and left uncommitted, so 80,000 changed rows.
	 */
	'long-file': defineFixture('long-file', async (repo) => {
		const numbered = (prefix: string): string =>
			Array.from({ length: 40_000 }, (_, i) => `${prefix} line ${String(i + 1)}\n`).join('');
		await repo.write('data/rows.txt', numbered('old'));
		await repo.write('data/dense.txt', 'a' + '\t'.repeat(140_000) + 'end\n');
		await repo.commit('base');
		await repo.write('data/rows.txt', numbered('new'));
	}),

	/**
	 * The agent trials' repositories (tests/agent-trials/), for the journeys that
	 * show what an agent made of them. Each is copied into a folder named as the
	 * trial named it, so the page says the same as the agent read.
	 */
	'trial-shop': defineFixture('shop', buildShop),
	'trial-ledger': defineFixture('ledger', buildLedger),

	/**
	 * A history to choose from (J17), made in the week before the journey's
	 * clock: main with a merge, `discounts` three commits ahead of it and checked
	 * out, an old local branch, a branch only on the remote, and a remote
	 * (a bare repository inside the clone's .git folder, so it is copied with
	 * it) whose main has a commit this copy has not fetched, while the local
	 * main has one the remote has not been sent. The fetch is recorded only in
	 * the remote branches' reflogs, at a fixed time.
	 */
	history: defineFixture(
		'shop',
		async (repo) => {
			const server = '.git/server.git';
			await repo.git('init', '--quiet', '--bare', '--initial-branch=main', server);
			await repo.write('README.md', lines('# Shop', '', 'A small shop.'));
			await repo.write(
				'src/cart.ts',
				lines('export function total(items: number[]): number {', '\treturn items.length;', '}')
			);
			await repo.commit('Start the shop');
			await repo.write('src/prices.ts', lines('export const PRICES = { tea: 3, cake: 4 };'));
			await repo.write(
				'src/cart.ts',
				lines(
					"import { PRICES } from './prices.ts';",
					'',
					'export function total(items: (keyof typeof PRICES)[]): number {',
					'\treturn items.reduce((sum, item) => sum + PRICES[item], 0);',
					'}'
				)
			);
			await repo.commit('Add prices');
			await repo.git('checkout', '--quiet', '-b', 'loyalty-card');
			await repo.write('src/loyalty.ts', lines('export const STAMPS_FOR_A_FREE_TEA = 9;'));
			await repo.commit('Try a loyalty card');
			await repo.git('checkout', '--quiet', '-b', 'tidy-styles', 'main');
			await repo.write('styles/site.css', lines('body {', '\tfont-family: sans-serif;', '}'));
			await repo.commit('Tidy the styles');
			await repo.git('checkout', '--quiet', 'main');
			await repo.git('merge', '--quiet', '--no-ff', '-m', 'Merge the tidier styles', 'tidy-styles');
			await repo.git('branch', '--quiet', '-D', 'tidy-styles');
			await repo.write(
				'src/basket.ts',
				lines(
					"import { total } from './cart.ts';",
					'',
					'export function basketLine(items: Parameters<typeof total>[0]): string {',
					'\treturn `Total: ${total(items)}`;',
					'}'
				)
			);
			await repo.commit('Show the total in the basket');
			await repo.git('checkout', '--quiet', '-b', 'discounts');
			await repo.write('src/discount.ts', lines('export const RATES = { SPRING: 0.1 };'));
			await repo.commit('Add a discount rate');
			await repo.write(
				'src/cart.ts',
				lines(
					"import { RATES } from './discount.ts';",
					"import { PRICES } from './prices.ts';",
					'',
					'export function total(items: (keyof typeof PRICES)[], code?: keyof typeof RATES): number {',
					'\tconst sum = items.reduce((sum, item) => sum + PRICES[item], 0);',
					'\treturn code === undefined ? sum : sum * (1 - RATES[code]);',
					'}'
				)
			);
			await repo.commit('Apply discounts at checkout');
			await repo.write(
				'src/basket.ts',
				lines(
					"import { total } from './cart.ts';",
					'',
					'export function basketLine(items: Parameters<typeof total>[0], code?: string): string {',
					"\tconst saved = code === undefined ? '' : ` with ${code}`;",
					'\treturn `Total: ${total(items)}${saved}`;',
					'}'
				)
			);
			await repo.commit('Say which code was used');
			await repo.git('checkout', '--quiet', 'main');
			await repo.write('README.md', lines('# Shop', '', 'A small shop that sells tea and cake.'));
			await repo.commit('Describe the shop');
			await repo.git('checkout', '--quiet', '-b', 'new-menu');
			await repo.write('src/menu.ts', lines("export const MENU = ['tea', 'cake'];"));
			await repo.commit('Add a menu');
			// Sent to the server by its address, so that only the fetch makes the remote branches.
			await repo.git('push', '--quiet', server, 'main', 'discounts', 'new-menu');
			await repo.git('remote', 'add', 'origin', server);
			await repo.git('fetch', '--quiet', 'origin');
			await repo.git('remote', 'set-head', 'origin', 'main');
			// Then someone else adds to main on the server.
			await repo.git('checkout', '--quiet', '--detach', 'main');
			await repo.write('README.md', lines('# Shop', '', 'Open every day but Monday.'));
			await repo.commit('Say when the shop is open');
			// Advance the server directly. Some git versions update origin/main
			// when a push names the remote's address instead of its name.
			await repo.git(
				`--git-dir=${server}`,
				'fetch',
				'--quiet',
				'--no-write-fetch-head',
				join(repo.dir, '.git'),
				'HEAD:refs/heads/main'
			);
			// And main here gets a commit that is not pushed.
			await repo.git('checkout', '--quiet', 'main');
			await repo.write('src/receipt.ts', lines("export const THANKS = 'Thank you!';"));
			await repo.commit('Thank the customer on the receipt');
			await repo.git('checkout', '--quiet', 'discounts');
			await repo.git('branch', '--quiet', '-D', 'new-menu');
			// Its time is the machine's; the reflogs hold the fetch's fixed one.
			await repo.remove('.git/FETCH_HEAD');
		},
		{ dates: { first: Math.floor(JOURNEY_TIME.getTime() / 1000) - 7 * 86_400, step: 12 * 3_600 } }
	),

	/** Changed images, uncommitted: one changed in place, one resized, one added, one deleted, and an SVG. */
	images: defineFixture('images', buildImages),

	/** On main, with nothing uncommitted and no other branch: nothing new to review. */
	'nothing-new': defineFixture('nothing-new', async (repo) => {
		await repo.write('src/app.ts', lines('export const name = "app";'));
		await repo.commit('Start');
	})
} as const satisfies Record<string, Fixture>;

export type JourneyRepositoryName = keyof typeof JOURNEY_REPOSITORIES;

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false
	);
}

/** Builds a fixture once per run; workers that race each build their own and the first rename wins. */
async function template(key: string, fixture: Fixture): Promise<string> {
	const done = join(root(), 'templates', key);
	if (await exists(done)) return done;
	const building = join(root(), 'building', randomUUID());
	await fixture.build(await GitRepo.init(absolutePath(building), fixture.options));
	await mkdir(join(root(), 'templates'), { recursive: true });
	try {
		await rename(building, done);
	} catch {
		await rm(building, { recursive: true, force: true });
	}
	return done;
}

/** git's environment for the reviewer in journeys: a home and global config of the run's own. */
async function reviewerGitEnv(): Promise<Readonly<Record<string, string>>> {
	const home = join(root(), 'reviewer');
	await mkdir(join(home, 'xdg'), { recursive: true });
	await writeFile(join(home, 'gitconfig'), '');
	return {
		HOME: home,
		XDG_CONFIG_HOME: join(home, 'xdg'),
		GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
		GIT_CONFIG_NOSYSTEM: '1'
	};
}

let app: Promise<AppHandler> | undefined;

/** One journey's world: its folder, its daemon and the repositories it has asked for. */
export interface JourneyWorld {
	readonly daemon: RunningDaemon;
	/** A private copy of a named repository, in a folder named as its fixture is. */
	repository(name: JourneyRepositoryName): Promise<string>;
	/**
	 * A recorded agent trial (tests/agent-trials/recordings/), replayed in
	 * `directory` against this journey's daemon: every MCP call, in order, as
	 * the agent sent it. Fails if the tools now accept or refuse one of them
	 * otherwise. Gives the address of the page of the report the agent sorted.
	 */
	agentTrial(
		recording: string,
		directory: string,
		afterCreate?: (address: string) => Promise<void>
	): Promise<string>;
	agentCall(tool: string, args: Readonly<Record<string, unknown>>): Promise<string>;
	/**
	 * The address an agent is given for the uncommitted changes of `directory`:
	 * what `create_report` answers through MCP, from a session that asked for no
	 * browser window, as `diff-delver mcp --no-open` does.
	 */
	agentLink(directory: string): Promise<string>;
	/**
	 * The address of the window the daemon last asked the system to open in the
	 * person's browser, taken once; undefined when it asked for none since.
	 */
	openedWindow(): string | undefined;
	/**
	 * What `diff-delver <args>` prints, and the address it opens, run in `directory`
	 * (or the journey's own empty folder) against this journey's daemon.
	 */
	command(
		args: readonly string[],
		directory: string | undefined
	): Promise<{ readonly output: string; readonly address: string }>;
	/** Stops the daemon and removes the journey's folder. */
	close(): Promise<void>;
}

export async function makeJourneyWorld(): Promise<JourneyWorld> {
	app ??= loadAppHandler();
	const dir = join(root(), 'journeys', randomUUID());
	const windows: string[] = [];
	const elsewhere = join(dir, 'elsewhere');
	await mkdir(elsewhere, { recursive: true });
	const time = parseTimestamp(JOURNEY_TIME.getTime());
	const version = parseCodeVersion('journey');
	if (!time.ok || !version.ok) throw new Error('The journey time or version does not parse.');
	const started = await startDaemon({
		dataDirectory: absolutePath(join(dir, 'data')),
		clock: settableClock(time.value),
		ids: sequentialIds(),
		version: version.value,
		app: await app,
		repository: { gitEnv: await reviewerGitEnv() },
		machine: {
			home: absolutePath(dir),
			defaultDataDirectory: absolutePath(join(dir, 'data'))
		},
		// No browser is opened: the journey plays the window itself, from its address.
		openBrowser: (address) => {
			windows.push(address);
			return Promise.resolve(true);
		}
	});
	if (!started.ok) throw new Error(describeDaemonStartError(started.error));
	const daemon = started.value;
	await daemon.cleaned;
	const client = new ApiClient({ fetch, base: daemon.origin, token: daemon.token });

	return {
		daemon,
		async repository(name) {
			const fixture = JOURNEY_REPOSITORIES[name];
			// A second repository of the same folder name, as a namesake elsewhere on the machine.
			const first = join(dir, 'src', fixture.name);
			const copy = (await exists(first)) ? join(dir, randomUUID(), fixture.name) : first;
			await cp(await template(name, fixture), copy, {
				recursive: true,
				verbatimSymlinks: true
			});
			return copy;
		},
		async agentTrial(name, directory, afterCreate) {
			const recording = await committedRecording(name);
			const report = recording.finalState.at(-1)?.id;
			if (report === undefined) throw new Error(`${name} made no report.`);
			const address = (): string =>
				entryAddress(daemon.origin, `/diffs/${report}`, daemon.entryCode());
			const session = await mcpOverHttp({
				origin: daemon.origin,
				token: daemon.mcpToken,
				directory
			});
			const data = join(dir, 'data');
			const paths = { repository: directory, data, trial: dir };
			try {
				const { changed } = await replay(
					recording,
					{
						...session,
						async call(tool, args) {
							const answer = await session.call(tool, args);
							if (tool === 'create_report' && !answer.refused && afterCreate !== undefined) {
								await afterCreate(address());
								afterCreate = undefined;
							}
							return answer;
						}
					},
					paths,
					normaliser(paths)
				);
				if (changed.length > 0) {
					throw new Error(
						`The tools no longer take ${name}'s calls as recorded:\n${changed.join('\n')}`
					);
				}
			} finally {
				await session.close();
			}
			return address();
		},
		async agentCall(tool, args) {
			const session = await mcpOverHttp({ origin: daemon.origin, token: daemon.mcpToken });
			try {
				const answer = await session.call(tool, args);
				if (answer.refused) throw new Error(`${tool} was refused: ${answer.text}`);
				return answer.text;
			} finally {
				await session.close();
			}
		},
		async agentLink(directory) {
			const session = await mcpOverHttp({
				origin: daemon.origin,
				token: daemon.mcpToken,
				directory
			});
			try {
				const answer = await session.call('create_report', { source: 'working-tree' });
				const address = /Give the person this address to open it in their browser: (http:\S+)/.exec(
					answer.text
				)?.[1];
				if (answer.refused || address === undefined) {
					throw new Error(`create_report gave no address: ${answer.text}`);
				}
				return address;
			} finally {
				await session.close();
			}
		},
		openedWindow() {
			return windows.pop();
		},
		async command(args, directory) {
			const parsed = parseCommandLine(args);
			if (!parsed.ok) return { output: describeCommandLineError(parsed.error), address: '' };
			const where = absolutePath(directory ?? elsewhere);
			const { command } = parsed.value;
			switch (command.kind) {
				case 'serve': {
					const address = entryAddress(daemon.origin, '/', daemon.entryCode());
					return {
						output: `diff delver is running. Open this in your browser: ${address}`,
						address
					};
				}
				case 'start':
				case 'open':
				case 'choose': {
					const outcome =
						command.kind === 'start'
							? await startOutcome(client, where)
							: command.kind === 'choose'
								? await chooseOutcome(client, where)
								: await openOutcome(client, where, command.source);
					const address = entryAddress(daemon.origin, outcome.page, daemon.entryCode());
					return {
						output: [...outcome.lines, `Open this in your browser: ${address}`].join('\n'),
						address
					};
				}
				case 'stop':
				case 'mcp':
				case 'help':
				case 'version':
					throw new Error(`diff-delver ${command.kind} opens no page; journeys do not run it.`);
			}
		},
		async close() {
			await daemon.stop();
			await rm(dir, { recursive: true, force: true });
		}
	};
}
