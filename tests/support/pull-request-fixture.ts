/**
 * A repository on the stand-in GitHub with pull requests, and a person's clone
 * of it: `acme/shop`, whose `discount` branch adds a discount rate. The
 * "upstream" is a real repository the stand-in serves, its `refs/pull/<n>/head`
 * following each pull request's branch; the clone is made from it, then
 * pointed at github.com, as a clone of GitHub would be, so nothing reads that
 * address but diff delver's own check of which remote is on GitHub.
 */
import { join } from 'node:path';
import { runGit } from '#lib/server/git/run-git.ts';
import { absolutePath, GitRepo } from './git-repo.ts';
import type { GitHubStandIn, StandInPull } from './github-stand-in.ts';

export const SHOP_OWNER = 'acme';
export const SHOP_NAME = 'shop';
export const SHOP_REMOTE = 'https://github.com/acme/shop.git';

const lines = (...text: readonly string[]): string => `${text.join('\n')}\n`;

/** The price code on main, before any pull request. */
export const PRICE_LINES = [
	'export function price(cents: number): number {',
	'\tif (cents < 0) {',
	"\t\tthrow new Error('A price is never negative');",
	'\t}',
	'\treturn cents;',
	'}',
	'',
	'export function total(prices: readonly number[]): number {',
	'\tlet sum = 0;',
	'\tfor (const p of prices) sum += price(p);',
	'\treturn sum;',
	'}'
];

/** Builds the upstream: main with the price code, and the `discount` and `receipt` branches on it. */
export async function buildShopUpstream(repo: GitRepo): Promise<void> {
	await repo.write('README.md', lines('# Shop', '', 'Prices and totals.'));
	await repo.write('src/price.ts', lines(...PRICE_LINES));
	await repo.commit('Start the shop');
	await repo.git('checkout', '--quiet', '-b', 'discount');
	await repo.write(
		'src/discount.ts',
		lines(
			'/** A rate off, from 0 to 1. */',
			'export function discounted(cents: number, rate: number): number {',
			'\treturn Math.round(cents * (1 - rate));',
			'}'
		)
	);
	await repo.write(
		'src/price.ts',
		lines(...PRICE_LINES, '', "export { discounted } from './discount.ts';")
	);
	await repo.commit('Add a discount rate');
	await repo.git('checkout', '--quiet', 'main');
	await repo.git('checkout', '--quiet', '-b', 'receipt');
	await repo.write(
		'src/receipt.ts',
		lines(
			'export function receipt(total: number): string {',
			'\treturn `Total: ${String(total)}`;',
			'}'
		)
	);
	await repo.commit('Print a receipt');
	await repo.git('checkout', '--quiet', 'main');
}

/** A clone of `upstream` in `dir`, whose `origin` is then github.com's address for the shop. */
export async function cloneShop(upstream: GitRepo, dir: string): Promise<GitRepo> {
	const cloned = await runGit({
		cwd: absolutePath(join(dir, '..')),
		args: ['clone', '--quiet', upstream.dir, dir]
	});
	if (!cloned.ok) throw new Error(`git clone failed: ${cloned.error.kind}`);
	const clone = GitRepo.open(absolutePath(dir));
	await clone.git('remote', 'set-url', 'origin', SHOP_REMOTE);
	return clone;
}

/** The pull request from `discount`, and the one from `receipt`, as the stand-in serves them. */
export const DISCOUNT_PULL: StandInPull = {
	number: 7,
	title: 'Add a discount rate',
	body: 'Prices can be **discounted** now.\n\nSee `discounted`.',
	state: 'open',
	author: 'octo',
	head: 'discount',
	base: 'main',
	updatedAt: 1_700_000_000
};

export const RECEIPT_PULL: StandInPull = {
	number: 8,
	title: 'Print a receipt',
	state: 'open',
	draft: true,
	author: 'hubot',
	head: 'receipt',
	base: 'main',
	updatedAt: 1_699_990_000,
	fork: 'hubot/shop'
};

/** Serves `upstream` as acme/shop with its two pull requests open. */
export async function serveShop(
	github: GitHubStandIn,
	upstream: GitRepo,
	options: { private?: boolean } = {}
): Promise<void> {
	github.addRepository(SHOP_OWNER, SHOP_NAME, upstream, options);
	await github.setPull(SHOP_OWNER, SHOP_NAME, DISCOUNT_PULL);
	await github.setPull(SHOP_OWNER, SHOP_NAME, RECEIPT_PULL);
}
