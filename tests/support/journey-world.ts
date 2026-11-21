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
import { openOutcome, startOutcome } from '../../src/lib/server/cli/outcome.ts';
import { loadAppHandler, type AppHandler } from '../../src/lib/server/daemon/app-handler.ts';
import {
	describeDaemonStartError,
	entryAddress,
	startDaemon,
	type RunningDaemon
} from '../../src/lib/server/daemon/daemon.ts';
import { absolutePath, defineFixture, GitRepo, type Fixture } from './git-repo.ts';

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
	 * valid UTF-8, and a lockfile.
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
		await repo.write('package-lock.json', lines('{ "lockfileVersion": 3, "packages": {} }'));
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
async function template(fixture: Fixture): Promise<string> {
	const done = join(root(), 'templates', fixture.name);
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
	/** A private copy of a named repository, in a folder of that name. */
	repository(name: JourneyRepositoryName): Promise<string>;
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
		repository: { gitEnv: await reviewerGitEnv() }
	});
	if (!started.ok) throw new Error(describeDaemonStartError(started.error));
	const daemon = started.value;
	await daemon.cleaned;
	const client = new ApiClient({ fetch, base: daemon.origin, token: daemon.token });

	return {
		daemon,
		async repository(name) {
			const copy = join(dir, randomUUID(), name);
			await cp(await template(JOURNEY_REPOSITORIES[name]), copy, {
				recursive: true,
				verbatimSymlinks: true
			});
			return copy;
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
				case 'open': {
					const outcome =
						command.kind === 'start'
							? await startOutcome(client, where)
							: await openOutcome(client, where, command.source);
					const address = entryAddress(daemon.origin, outcome.page, daemon.entryCode());
					return {
						output: [...outcome.lines, `Open this in your browser: ${address}`].join('\n'),
						address
					};
				}
				case 'stop':
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
