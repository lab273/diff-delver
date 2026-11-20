/**
 * `diff-delver stop`'s half of the launcher, in the test's own process: it
 * signals a process only when a daemon answers for it, never one a lockfile
 * merely names.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it, onTestFinished } from 'vitest';
import { tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { testDaemon } from '../../../../tests/support/daemons.ts';
import { stopDaemon } from './launcher.ts';
import { lockfilePath, readLockfile } from './lockfile.ts';

/** Any program that is not diff delver, running until the test finishes. */
async function unrelatedProcess(): Promise<ChildProcess & { readonly pid: number }> {
	const other = spawn('sleep', ['60'], { stdio: 'ignore' });
	onTestFinished(() => {
		other.kill();
	});
	await new Promise<void>((resolve, reject) => {
		other.once('spawn', resolve);
		other.once('error', reject);
	});
	const { pid } = other;
	if (pid === undefined) throw new Error('no pid');
	return Object.assign(other, { pid });
}

describe('diff-delver stop', () => {
	it('leaves alone a process a lockfile names when the daemon that answers there is another process', async () => {
		const dataDirectory = await tempDirectory();
		const daemon = await testDaemon({ dataDirectory });
		const other = await unrelatedProcess();
		// The lockfile names the daemon's port and token, but another process.
		const held = await readLockfile(dataDirectory);
		if (held.kind !== 'lock') throw new Error('no lock');
		await writeFile(lockfilePath(dataDirectory), JSON.stringify({ ...held.lock, pid: other.pid }));
		expect(await stopDaemon(dataDirectory)).toEqual({ kind: 'stale' });
		expect(await readLockfile(dataDirectory)).toEqual({ kind: 'none' });
		expect(other.exitCode).toBeNull();
		expect(other.signalCode).toBeNull();
		// Nor was the daemon asked to stop: it still answers.
		expect((await fetch(`${daemon.origin}/api/daemon`)).status).toBe(403);
	});

	it('stops a daemon that answers', async () => {
		const dataDirectory = await tempDirectory();
		const daemon = await testDaemon({ dataDirectory });
		expect(await stopDaemon(dataDirectory)).toEqual({ kind: 'stopped' });
		await daemon.stopped;
		expect(await readLockfile(dataDirectory)).toEqual({ kind: 'none' });
	});
});
