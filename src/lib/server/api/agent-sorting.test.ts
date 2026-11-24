/**
 * How to have an agent sort a Delve (`GET /api/diffs/:id/agent`), against real
 * daemons on real repositories, each with a data folder of its own: what a
 * daemon gives to copy for the copy it is and the folder it serves, what it
 * says of the agents it has heard from, and that the sentence it gives is
 * enough for an agent to sort that very Delve, through the real stdio shim.
 */
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { claudeCodeCommand, copyOf } from '#lib/core/agent-setup/agent-server.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { BUILT_COMMAND } from '../../../../tests/support/build.ts';
import { browserClient, clientOf, testDaemon, version } from '../../../../tests/support/daemons.ts';
import {
	defineFixture,
	tempDirectory,
	useFixture
} from '../../../../tests/support/fixture-repos.ts';
import { absolutePath } from '../../../../tests/support/git-repo.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { mcpOverHttp, mcpThroughShim } from '../../../../tests/support/mcp-client.ts';
import { reviewer, type Reviewer } from '../../../../tests/support/reviewer-git.ts';
import { buildShop, sortShop } from '../../../../tests/support/scripted-categorisation.ts';
import { settableClock } from '#lib/core/clock.ts';
import { parseTimestamp } from '#lib/core/timestamp.tiny.ts';
import { connectionOf, type RunningDaemon } from '../daemon/daemon.ts';
import { readLockfile } from '../daemon/lockfile.ts';

const shop = defineFixture('agent-sorting-shop', buildShop);

const RELEASE = 'https://github.com/lab273/diff-delver/releases/latest/download/diff-delver.tgz';

async function openChanges(daemon: RunningDaemon, directory: AbsolutePath): Promise<ReportId> {
	const opened = value(await clientOf(daemon).open({ directory, source: 'working-tree' }));
	if (opened.kind !== 'opened') throw new Error('The shop has nothing to review.');
	return opened.diff.id;
}

describe('what a Delve’s page gives to copy', () => {
	it('for a release on the machine’s own data folder is the README’s command, and names the Delve', async () => {
		const repo = await useFixture(shop);
		const data = await tempDirectory();
		const daemon = await testDaemon({
			dataDirectory: data,
			version: version('0.3.0+1a2b3c4d5e6f'),
			machine: { defaultDataDirectory: data, entry: absolutePath('/srv/npx/bin/diff-delver') }
		});
		const id = await openChanges(daemon, repo.dir);
		const found = value(await clientOf(daemon).agentSorting(id));
		expect(found.connect.claudeCode).toBe(
			`claude mcp add --scope user diff-delver -- npx --yes ${RELEASE} mcp`
		);
		expect(found.connect.other).toBe(`npx --yes ${RELEASE} mcp`);
		expect(found.connect.codex).toBe(
			`[mcp_servers.diff-delver]\ncommand = "npx"\nargs = ["--yes", "${RELEASE}", "mcp"]`
		);
		expect(found.folder).toEqual({ shown: repo.dir, command: `cd ${repo.dir}`, there: true });
		expect(found.request).toBe(
			`Sort diff delver report ${id} into sections for review: “Uncommitted changes” in ${basename(repo.dir)}. The report already exists, so do not create another one. Start with get_manifest for report ${id}.`
		);
		expect(found.heard).toBeNull();
		expect(found.worked).toBeNull();
	});

	it('for a build from a clone on another data folder runs that build on that folder', async () => {
		const repo = await useFixture(shop);
		const data = await tempDirectory();
		const daemon = await testDaemon({
			dataDirectory: data,
			version: version('0.3.0-dev+1a2b3c4d5e6f'),
			machine: {
				entry: absolutePath('/home/reviewer/my clones/diff-delver/bin/diff-delver.js'),
				node: absolutePath('/usr/local/bin/node'),
				defaultDataDirectory: absolutePath('/home/reviewer/.local/share/diff-delver'),
				home: absolutePath('/home/reviewer')
			}
		});
		const id = await openChanges(daemon, repo.dir);
		const found = value(await clientOf(daemon).agentSorting(id));
		expect(found.connect.claudeCode).toBe(
			`claude mcp add --scope user diff-delver -- /usr/local/bin/node ~/'my clones/diff-delver/bin/diff-delver.js' mcp --data-directory ${data}`
		);
		expect(found.connect.other).toBe(
			`/usr/local/bin/node '/home/reviewer/my clones/diff-delver/bin/diff-delver.js' mcp --data-directory ${data}`
		);
		expect(found.connect.codex).toContain(
			`args = ["/home/reviewer/my clones/diff-delver/bin/diff-delver.js", "mcp", "--data-directory", "${data}"]`
		);
	});

	it('names the data folder when the daemon was not told which is the machine’s', async () => {
		const repo = await useFixture(shop);
		const data = await tempDirectory();
		const daemon = await testDaemon({ dataDirectory: data });
		const found = value(await clientOf(daemon).agentSorting(await openChanges(daemon, repo.dir)));
		expect(found.connect.other).toBe(`npx --yes ${RELEASE} mcp --data-directory ${data}`);
	});

	it('says when the repository’s folder is no longer there, and still names the Delve', async () => {
		const repo = await useFixture(shop);
		const daemon = await testDaemon();
		const id = await openChanges(daemon, repo.dir);
		await rm(repo.dir, { recursive: true });
		const found = value(await clientOf(daemon).agentSorting(id));
		expect(found.folder.there).toBe(false);
		expect(found.folder.shown).toBe(repo.dir);
		expect(found.request).toContain(`report ${id}`);
	});

	it('is read by a browser as by the command, and is refused for a Delve that does not exist', async () => {
		const repo = await useFixture(shop);
		const daemon = await testDaemon();
		const id = await openChanges(daemon, repo.dir);
		const browser = await browserClient(daemon);
		expect(value(await browser.agentSorting(id)).request).toContain(id);
		value(await browser.deleteDiff(id));
		const gone = await browser.agentSorting(id);
		expect(gone.ok).toBe(false);
		expect(gone.ok ? undefined : gone.error).toMatchObject({
			status: 404,
			reason: 'ReportNotFound'
		});
	});
});

describe('what a daemon says of the agents it has heard from', () => {
	it('says when one connected and where it was started, and when one worked on the Delve', async () => {
		const repo = await useFixture(shop);
		const time = parseTimestamp(Date.UTC(2026, 0, 15, 9, 30));
		if (!time.ok) throw new Error('bad time');
		const clock = settableClock(time.value);
		const home = absolutePath(join(repo.dir, '..'));
		const daemon = await testDaemon({ clock, machine: { home } });
		const id = await openChanges(daemon, repo.dir);
		const client = clientOf(daemon);

		// An agent started somewhere else: said, and not called this Delve's.
		const elsewhere = '/srv/agents/elsewhere';
		const other = await mcpOverHttp({
			origin: daemon.origin,
			token: daemon.mcpToken,
			directory: elsewhere
		});
		onTestFinished(() => other.close());
		await other.call('list_reports');
		// A call that names the Delve and is refused is no work on it.
		const refused = await other.call('get_manifest', { report: id, unknown: true });
		expect(refused.refused).toBe(true);
		const first = value(await client.agentSorting(id));
		expect(first.heard).toEqual({
			text: `An agent connected to this diff delver a moment ago, started in ${elsewhere}.`,
			here: false
		});
		expect(first.worked).toBeNull();

		// One started in a folder of the repository: that one is told of, by its folder from ~.
		clock.advance(60_000);
		await mkdir(join(repo.dir, 'src'), { recursive: true });
		const inside = await mcpOverHttp({
			origin: daemon.origin,
			token: daemon.mcpToken,
			directory: join(repo.dir, 'src')
		});
		onTestFinished(() => inside.close());
		await inside.call('get_manifest', { report: id });
		clock.advance(5 * 60_000);
		await other.call('list_reports');
		const later = value(await client.agentSorting(id));
		expect(later.heard).toEqual({
			text: `An agent connected to this diff delver 5 minutes ago, started in ~/${basename(repo.dir)}/src.`,
			here: true
		});
		expect(later.worked).toBe('An agent last worked on this Delve 5 minutes ago.');
		expect(later.folder.shown).toBe(`~/${basename(repo.dir)}`);
		expect(later.folder.command).toBe(`cd ~/${basename(repo.dir)}`);
	});
});

function env(who: Reviewer): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = { ...process.env, ...who.gitEnv };
	delete out['DIFF_DELVER_DATA_DIRECTORY'];
	return out;
}

function run(args: readonly string[], cwd: string, who: Reviewer): Promise<string> {
	return new Promise((resolve) => {
		execFile(process.execPath, [BUILT_COMMAND, ...args], { cwd, env: env(who) }, (_e, stdout) => {
			resolve(stdout);
		});
	});
}

describe('the sentence the page gives, pasted to an agent', () => {
	it('is enough to sort that Delve from another folder, and the command runs the copy that serves it', async () => {
		const repo = await useFixture(shop);
		const data = await tempDirectory();
		const who = await reviewer();
		// The person opens their changes with the command, which starts the daemon.
		await run(['open', 'working-tree', '--no-open', '--data-directory', data], repo.dir, who);
		onTestFinished(async () => {
			await run(['stop', '--data-directory', data], data, who);
		});
		const lock = await readLockfile(data);
		if (lock.kind !== 'lock') throw new Error('The command started no daemon.');
		const client = clientOf(connectionOf(lock.lock));
		const [delve, ...others] = value(await client.listDiffs()).diffs;
		if (delve?.kind !== 'diff' || others.length > 0) throw new Error('Expected one Delve.');

		// What its page gives: the command for the copy that is running, on its data folder.
		const found = value(await client.agentSorting(delve.id));
		const info = value(await client.daemonInfo());
		expect(found.connect.claudeCode).toBe(
			claudeCodeCommand({
				copy: copyOf(info.version, absolutePath(BUILT_COMMAND), absolutePath(process.execPath)),
				dataDirectory: data,
				// The daemon's home folder is the test reviewer's, never the machine's.
				home: absolutePath(who.gitEnv['HOME'] ?? '')
			})
		);

		// An agent started in a folder that is no repository, given only the sentence.
		const named = /report (r_[0-9a-z]+)/.exec(found.request)?.[1];
		expect(named).toBe(delve.id);
		expect(found.request).toContain('do not create another one');
		expect(found.request).toContain(`Start with get_manifest for report ${delve.id}.`);
		const folder = await tempDirectory();
		const session = await mcpThroughShim({ cwd: folder, dataDirectory: data, env: env(who) });
		onTestFinished(() => session.close());
		const sorted = await sortShop(session, named ?? '');
		expect(sorted.calls.at(0)?.tool).toBe('get_manifest');
		expect(sorted.calls.at(-1)?.answer.text).toMatch(/Nothing is left to sort/);

		// It sorted the Delve the person has open, and made no other.
		const after = value(await client.listDiffs()).diffs;
		expect(after.map((d) => (d.kind === 'diff' ? d.id : undefined))).toEqual([delve.id]);
		const page = value(await client.loadDiff(delve.id));
		expect(page.groups.map((group) => group.key.kind)).toEqual([
			'section',
			'section',
			'section',
			'ignored'
		]);

		// And the page can say so.
		const now = value(await client.agentSorting(delve.id));
		expect(now.heard?.here).toBe(false);
		expect(now.heard?.text).toMatch(
			/^An agent connected to this diff delver a moment ago, started in /
		);
		expect(now.worked).toBe('An agent last worked on this Delve a moment ago.');
	});
});
