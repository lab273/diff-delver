/**
 * The launcher, in the test's own process: `diff-delver stop`'s half signals a
 * process only when a daemon answers for it, never one a lockfile merely names;
 * and finding a daemon of another release uses a newer one as it is and
 * replaces an older one.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it, onTestFinished } from 'vitest';
import { tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { join } from 'node:path';
import { testDaemon, version } from '../../../../tests/support/daemons.ts';
import { ensureDaemon, stopDaemon } from './launcher.ts';
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

describe('finding a daemon of another release', () => {
	it('uses a newer one as it is, and says it is newer', async () => {
		const dataDirectory = await tempDirectory();
		const daemon = await testDaemon({ dataDirectory, version: version('0.3.0+aaaaaaaaaaaa') });
		// Were it to start a daemon of its own, this command could not.
		const nowhere = join(await tempDirectory(), 'no-such-command.js');
		const launched = await ensureDaemon(dataDirectory, version('0.2.0+bbbbbbbbbbbb'), nowhere);
		expect(launched).toEqual({
			ok: true,
			value: {
				connection: { port: daemon.port, token: daemon.token, origin: daemon.origin },
				found: { kind: 'newer', version: '0.3.0+aaaaaaaaaaaa' }
			}
		});
		expect((await fetch(`${daemon.origin}/api/daemon`)).status).toBe(403);
		expect(await readLockfile(dataDirectory)).toMatchObject({
			kind: 'lock',
			lock: { version: '0.3.0+aaaaaaaaaaaa' }
		});
	});

	it('stops an older one, to start its own in its place', async () => {
		const dataDirectory = await tempDirectory();
		const daemon = await testDaemon({ dataDirectory, version: version('0.1.0+aaaaaaaaaaaa') });
		const nowhere = join(await tempDirectory(), 'no-such-command.js');
		const launched = await ensureDaemon(dataDirectory, version('0.2.0+bbbbbbbbbbbb'), nowhere);
		await daemon.stopped;
		// The test's command cannot start: what matters is that the older daemon was stopped for it.
		expect(launched.ok ? undefined : launched.error.kind).toBe('StartFailed');
	});
});
