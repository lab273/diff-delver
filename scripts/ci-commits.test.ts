/**
 * The commit listing that CI's verify workflow runs (`scripts/ci-commits.sh`),
 * against real repositories: which commits a push must verify, in order, and how
 * they are split into jobs.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { emptyRepo } from '../tests/support/fixture-repos.ts';
import type { GitRepo } from '../tests/support/git-repo.ts';

const run = promisify(execFile);
const SCRIPT = join(import.meta.dirname, 'ci-commits.sh');
const ZERO = '0'.repeat(40);

interface Batch {
	readonly name: string;
	readonly first: string;
	readonly size: number;
	readonly commits: string;
}

interface Push {
	readonly event?: string;
	readonly before: string;
	readonly after: string;
	readonly maxJobs?: number;
}

/** Runs the script in the repository as CI would and returns the batches it prints. */
async function batches(repo: GitRepo, push: Push): Promise<readonly Batch[]> {
	const { stdout } = await run('bash', [SCRIPT], {
		cwd: repo.dir,
		env: {
			PATH: process.env['PATH'] ?? '',
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CONFIG_GLOBAL: '/dev/null',
			EVENT: push.event ?? 'push',
			BEFORE: push.before,
			AFTER: push.after,
			BRANCH: 'main',
			REMOTE: 'origin',
			MAX_JOBS: String(push.maxJobs ?? 256)
		}
	});
	const parsed: unknown = JSON.parse(stdout);
	if (!Array.isArray(parsed)) throw new Error(`not a list: ${stdout}`);
	const list: readonly unknown[] = parsed;
	return list.map((entry) => {
		const fields = new Map<string, unknown>(
			typeof entry === 'object' && entry !== null ? Object.entries(entry) : []
		);
		const text = (key: string): string => {
			const value = fields.get(key);
			if (typeof value !== 'string') throw new Error(`no ${key} in ${stdout}`);
			return value;
		};
		const size = fields.get('size');
		if (typeof size !== 'number') throw new Error(`no size in ${stdout}`);
		return { name: text('name'), first: text('first'), size, commits: text('commits') };
	});
}

/** Every commit the batches will verify, in order. */
async function listed(repo: GitRepo, push: Push): Promise<readonly string[]> {
	return (await batches(repo, push)).flatMap((b) => b.commits.split(' '));
}

/** Makes `count` commits on main, one git call each, and returns their ids in order. */
async function commits(repo: GitRepo, count: number, label: string): Promise<readonly string[]> {
	const ids: string[] = [];
	for (let i = 0; i < count; i += 1) {
		await repo.write('file.txt', `${label} ${String(i)}\n`);
		ids.push((await repo.commit(`${label} ${String(i)}`)).commit);
	}
	return ids;
}

/** Records `id` as the remote's copy of `ref`, as a fetch would. */
async function remoteRef(repo: GitRepo, ref: string, id: string): Promise<void> {
	await repo.git('update-ref', `refs/remotes/origin/${ref}`, id);
}

describe('ci-commits.sh', () => {
	it('lists the pushed commits oldest first, one per job', async () => {
		const repo = await emptyRepo();
		const [before = ''] = await commits(repo, 1, 'base');
		const pushed = await commits(repo, 3, 'pushed');
		const after = pushed.at(-1) ?? '';
		await remoteRef(repo, 'main', after);
		const result = await batches(repo, { before, after });
		expect(result.map((b) => b.commits)).toEqual(pushed);
		expect(result.map((b) => [b.name, b.first, b.size])).toEqual(pushed.map((c) => [c, c, 1]));
	});

	it('on a first push, lists every commit no other branch or tag of the remote had', async () => {
		const repo = await emptyRepo();
		const shared = await commits(repo, 2, 'shared');
		await remoteRef(repo, 'other', shared.at(-1) ?? '');
		const tagged = await commits(repo, 1, 'tagged');
		await repo.git('tag', 'v1');
		const fresh = await commits(repo, 2, 'fresh');
		const after = fresh.at(-1) ?? '';
		await remoteRef(repo, 'main', after);
		expect(await listed(repo, { before: ZERO, after })).toEqual(fresh);
		expect(tagged).toHaveLength(1);
	});

	it('on a force push whose old head is gone, lists every commit the remote did not have', async () => {
		const repo = await emptyRepo();
		const kept = await commits(repo, 1, 'kept');
		await remoteRef(repo, 'release', kept.at(-1) ?? '');
		const rewritten = await commits(repo, 10, 'rewritten');
		const after = rewritten.at(-1) ?? '';
		await remoteRef(repo, 'main', after);
		const gone = 'f'.repeat(40);
		expect(await listed(repo, { before: gone, after })).toEqual(rewritten);
	});

	it('on a force push whose old head is still known, lists the commits that replaced it', async () => {
		const repo = await emptyRepo();
		const base = await commits(repo, 2, 'base');
		const old = await commits(repo, 3, 'old');
		await repo.git('reset', '--quiet', '--hard', base.at(-1) ?? '');
		const replacing = await commits(repo, 4, 'new');
		const after = replacing.at(-1) ?? '';
		await remoteRef(repo, 'main', after);
		expect(await listed(repo, { before: old.at(-1) ?? '', after })).toEqual(replacing);
	});

	it('checks the head commit when there is nothing new, and on a manual run', async () => {
		const repo = await emptyRepo();
		const ids = await commits(repo, 3, 'c');
		const head = ids.at(-1) ?? '';
		await remoteRef(repo, 'main', head);
		expect(await listed(repo, { before: head, after: head })).toEqual([head]);
		expect(await listed(repo, { event: 'workflow_dispatch', before: '', after: head })).toEqual([
			head
		]);
	});

	it('splits more commits than the job limit into that many batches, keeping every commit in order', async () => {
		const repo = await emptyRepo();
		const [before = ''] = await commits(repo, 1, 'base');
		const pushed = await commits(repo, 7, 'pushed');
		const after = pushed.at(-1) ?? '';
		await remoteRef(repo, 'main', after);
		const result = await batches(repo, { before, after, maxJobs: 3 });
		expect(result.map((b) => b.size)).toEqual([2, 2, 3]);
		expect(result.flatMap((b) => b.commits.split(' '))).toEqual(pushed);
		expect(result.map((b) => b.first)).toEqual([pushed[0], pushed[2], pushed[4]]);
		expect(result[0]?.name).toBe(`${pushed[0]?.slice(0, 12) ?? ''} and 1 more`);
	});
});
