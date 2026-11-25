/**
 * GitHub pull requests through a real daemon and the stand-in GitHub: the
 * choose page's routes offer and list them, `/api/open` and the command open
 * one by its address, and an agent sorts it through MCP, reading its title and
 * description in the manifest.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReportId } from '#lib/core/report-id.tiny.ts';
import { parseSourceSpec } from '#lib/core/sources/source-spec.ts';
import { openOutcome } from '../cli/outcome.ts';
import { clientOf, testDaemon } from '../../../../tests/support/daemons.ts';
import { tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { absolutePath, GitRepo } from '../../../../tests/support/git-repo.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import {
	startGitHubStandIn,
	type GitHubStandIn
} from '../../../../tests/support/github-stand-in.ts';
import { mcpOverHttp, reportIn } from '../../../../tests/support/mcp-client.ts';
import {
	buildShopUpstream,
	cloneShop,
	DISCOUNT_PULL,
	serveShop
} from '../../../../tests/support/pull-request-fixture.ts';

const standIns: GitHubStandIn[] = [];
afterEach(async () => {
	await Promise.all(standIns.splice(0).map((s) => s.close()));
});

async function setUp() {
	const root = await tempDirectory();
	const upstream = await GitRepo.init(absolutePath(join(root, 'upstream')));
	await buildShopUpstream(upstream);
	const clone = await cloneShop(upstream, join(root, 'shop'));
	const github = await startGitHubStandIn();
	standIns.push(github);
	await serveShop(github, upstream);
	const daemon = await testDaemon({ github: github.access() });
	return { clone, github, daemon, client: clientOf(daemon) };
}

describe('pull requests through the daemon', () => {
	it('are offered on the choose page without asking GitHub, and listed when asked', async () => {
		const { clone, github, client } = await setUp();
		const history = value(await client.history({ directory: clone.dir, find: '' }));
		expect(history.gitHub).toEqual({ remote: 'origin', repository: 'acme/shop' });
		expect(github.requests).toEqual([]);
		const listed = value(await client.pullRequests({ directory: clone.dir }));
		expect(listed.repository).toBe('acme/shop');
		expect(listed.summary).toBe(
			'2 open pull requests in acme/shop, most recently updated first. Choose one to review it.'
		);
		expect(listed.pulls.map((p) => [p.source, p.title, p.draft])).toEqual([
			['https://github.com/acme/shop/pull/7', '#7 Add a discount rate', false],
			['https://github.com/acme/shop/pull/8', '#8 Print a receipt', true]
		]);
		expect(listed.pulls[1]?.details).toBe(
			'By hubot, from a fork’s receipt into main, updated 2 years ago'
		);
	});

	it('opens one by its address from the command, which an agent then sorts by the report’s id', async () => {
		const { clone, daemon, client } = await setUp();
		const spec = value(parseSourceSpec('https://github.com/acme/shop/pull/7'));
		const outcome = await openOutcome(client, clone.dir, spec);
		expect(outcome.exitCode).toBe(0);
		expect(outcome.lines[0]).toMatch(
			/^Pull request #7: “Add a discount rate” in shop: 2 files changed/
		);
		const id = value(parseReportId((outcome.page ?? '').replace('/diffs/', '')));

		const sorting = value(await client.agentSorting(id));
		expect(sorting.folder.shown).toBe(clone.dir);
		expect(sorting.request).toContain(`“Pull request #7: “Add a discount rate”” in shop`);

		const agent = await mcpOverHttp({
			origin: daemon.origin,
			token: daemon.mcpToken,
			directory: clone.dir
		});
		try {
			const created = await agent.call('create_report', {
				source: 'https://github.com/acme/shop/pull/7'
			});
			expect(created.refused).toBe(false);
			expect(reportIn(created)).toBe(id);
			const manifest = await agent.call('get_manifest', { report: id });
			expect(manifest.text).toContain(
				'This report follows pull request acme/shop#7 (https://github.com/acme/shop/pull/7).'
			);
			expect(manifest.text).toContain('Title: "Add a discount rate"');
			expect(manifest.text).toContain(
				'Description: "Prices can be **discounted** now.\\n\\nSee `discounted`."'
			);
		} finally {
			await agent.close();
		}
	});

	it('says why one cannot be opened, and opens no page that would not say it', async () => {
		const { clone, github, client } = await setUp();
		github.refuseWith(429);
		const spec = value(parseSourceSpec('https://github.com/acme/shop/pull/7'));
		const outcome = await openOutcome(client, clone.dir, spec);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.lines[0]).toContain('too many requests');
		expect(outcome.page).toBeUndefined();

		github.refuseWith(undefined);
		await github.setPull('acme', 'shop', { ...DISCOUNT_PULL, number: 9, state: 'merged' });
		const merged = await openOutcome(
			client,
			clone.dir,
			value(parseSourceSpec('https://github.com/acme/shop/pull/9'))
		);
		expect(merged).toMatchObject({ exitCode: 0, page: undefined });
		expect(merged.lines.join(' ')).toContain('merged');

		const bad = await client.open({
			directory: clone.dir,
			source: 'https://gitlab.com/a/b/-/merge_requests/1'
		});
		expect(!bad.ok && bad.error.kind === 'refused' && bad.error.message).toContain(
			'github.com only'
		);
	});
});
