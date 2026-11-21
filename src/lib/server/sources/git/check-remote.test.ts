import { createServer } from 'node:http';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parseRemoteName, type RemoteName } from '#lib/core/history/remote-name.tiny.ts';
import { listingsAround } from '../../../../../tests/support/directory-listing.ts';
import { emptyRepo, tempDirectory } from '../../../../../tests/support/fixture-repos.ts';
import { absolutePath, GitRepo } from '../../../../../tests/support/git-repo.ts';
import { value } from '../../../../../tests/support/git-source-helpers.ts';
import { reviewer } from '../../../../../tests/support/reviewer-git.ts';
import { checkRemote, type RemoteOutcome } from './check-remote.ts';
import { trackedBranches } from './history.ts';
import { locateRepository } from './index.ts';

const origin = value(parseRemoteName('origin'));

/** A clone of a bare server with `main` and `prices`, and the server itself, which a second clone can push to. */
async function cloned(): Promise<{ repo: GitRepo; server: string }> {
	const work = await emptyRepo();
	await work.write('a.txt', 'a\n');
	await work.commit('Start');
	await work.git('branch', 'prices');
	const server = join(await tempDirectory(), 'server.git');
	await work.git('clone', '--quiet', '--bare', work.dir, server);
	const dir = absolutePath(join(await tempDirectory(), 'shop'));
	await work.git('clone', '--quiet', server, dir);
	return { repo: GitRepo.open(dir), server };
}

async function check(repo: GitRepo, remote: RemoteName = origin, seconds?: number) {
	const who = await reviewer();
	const found = value(await locateRepository(repo.dir, { gitEnv: who.gitEnv }));
	const tracked = value(await trackedBranches(found));
	const { before, after, result } = await listingsAround([repo.dir], () =>
		checkRemote(found, remote, tracked, seconds)
	);
	expect(after).toEqual(before);
	return result;
}

function kindOf(outcome: RemoteOutcome): string {
	return outcome.kind === 'compared' ? 'compared' : outcome.error.kind;
}

/** Whether a process with this id exists: signal 0 only asks. */
function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** A program called `ssh` that writes its arguments to a file and then runs `then`. */
async function fakeSsh(then: string): Promise<{ command: string; args: string }> {
	const dir = await tempDirectory();
	await mkdir(join(dir, 'bin'));
	const command = join(dir, 'bin', 'ssh');
	const args = join(dir, 'args.txt');
	await writeFile(command, `#!/bin/sh\necho "$@" > '${args}'\n${then}\n`);
	await chmod(command, 0o755);
	return { command, args };
}

describe('asking a remote what it has', () => {
	it('finds branches that moved on since the last fetch and new ones, writing nothing', async () => {
		const { repo, server } = await cloned();
		expect(await check(repo)).toEqual({
			kind: 'compared',
			comparison: { remote: origin, changed: [], added: [] }
		});
		const other = absolutePath(join(await tempDirectory(), 'other'));
		await repo.git('clone', '--quiet', server, other);
		const pusher = GitRepo.open(other);
		await pusher.write('b.txt', 'b\n');
		await pusher.commit('Elsewhere');
		await pusher.git('push', '--quiet', 'origin', 'main', 'main:docs');
		expect(await check(repo)).toEqual({
			kind: 'compared',
			comparison: { remote: origin, changed: ['main'], added: ['docs'] }
		});
	});

	it('says a remote with nothing at its address is not found', async () => {
		const { repo } = await cloned();
		await repo.git('remote', 'set-url', 'origin', join(repo.dir, 'nowhere.git'));
		expect(kindOf(await check(repo))).toBe('RemoteNotFound');
	});

	it('runs ssh in batch mode, so a key with a passphrase is never asked for', async () => {
		const { repo } = await cloned();
		const ssh = await fakeSsh(
			`echo 'git@example.invalid: Permission denied (publickey).' >&2; exit 255`
		);
		await repo.git('config', 'core.sshCommand', ssh.command);
		await repo.git('remote', 'set-url', 'origin', 'ssh://git@example.invalid/shop.git');
		expect(kindOf(await check(repo))).toBe('RemoteNeedsLogin');
		expect(await readFile(ssh.args, 'utf8')).toContain('-o BatchMode=yes -o ConnectTimeout=10');
	});

	it('gives up on a remote that does not answer within the time limit, and stops what it started', async () => {
		const { repo } = await cloned();
		// An ssh that never answers, and starts a program of its own that would outlive it.
		const pids = join(await tempDirectory(), 'pids.txt');
		const ssh = await fakeSsh(`sleep 300 &\necho "$$ $!" > '${pids}'\nwait`);
		await repo.git('config', 'core.sshCommand', ssh.command);
		await repo.git('remote', 'set-url', 'origin', 'ssh://git@example.invalid/shop.git');
		const outcome = await check(repo, origin, 1);
		expect(outcome).toEqual({
			kind: 'failed',
			error: { kind: 'RemoteTimedOut', remote: origin, seconds: 1 }
		});
		// Both ran, and neither is left: the ssh git started, and what that ssh started.
		const started = (await readFile(pids, 'utf8')).trim().split(' ').map(Number);
		expect(started).toHaveLength(2);
		expect(started.every((pid) => Number.isSafeInteger(pid) && pid > 1)).toBe(true);
		await expect.poll(() => started.filter(isRunning), { timeout: 10_000 }).toEqual([]);
	});

	it('never asks for a password when a remote over HTTP wants one', async () => {
		const { repo } = await cloned();
		const server = createServer((_request, response) => {
			response.writeHead(401, { 'www-authenticate': 'Basic realm="shop"' });
			response.end();
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		onTestFinished(
			() =>
				new Promise<void>((resolve) => {
					server.close(() => {
						resolve();
					});
				})
		);
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('The server has no port.');
		const { port } = address;
		await repo.git('remote', 'set-url', 'origin', `http://127.0.0.1:${String(port)}/shop.git`);
		expect(kindOf(await check(repo))).toBe('RemoteNeedsLogin');
	});
});
