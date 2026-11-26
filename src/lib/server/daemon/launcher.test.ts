/**
 * The launcher, in the test's own process: `diff-delver stop`'s half signals a
 * process only when a daemon answers for it, never one a lockfile merely names;
 * finding a daemon of another release uses a newer one as it is and
 * replaces an older one, but never one serving a database this copy is too old
 * for; and a daemon the call started itself is used, whatever its version.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { join } from 'node:path';
import { BUILT_COMMAND } from '../../../../tests/support/build.ts';
import { testDaemon, version } from '../../../../tests/support/daemons.ts';
import { DATABASE_FILE, LATEST_VERSION } from '../db/index.ts';
import { ensureDaemon, stopDaemon, versionOnDisk } from './launcher.ts';
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
				connection: {
					port: daemon.port,
					token: daemon.token,
					mcpToken: daemon.mcpToken,
					origin: daemon.origin
				},
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

describe('a copy too old for the data folder', () => {
	it('keeps the daemon that is running, and says this copy is older than its data folder', async () => {
		const dataDirectory = await tempDirectory();
		const daemon = await testDaemon({ dataDirectory, version: version('0.0.1-dev+aaaaaaaaaaaa') });
		// A newer diff delver has changed the database in a way this copy does not know.
		const database = new DatabaseSync(join(dataDirectory, DATABASE_FILE));
		database
			.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
			.run(LATEST_VERSION + 1, 'from a newer diff delver', 0);
		database.close();
		const nowhere = join(await tempDirectory(), 'no-such-command.js');
		const launched = await ensureDaemon(dataDirectory, version('0.0.1+bbbbbbbbbbbb'), nowhere);
		expect(launched).toMatchObject({
			ok: true,
			value: {
				connection: { port: daemon.port, token: daemon.token },
				found: { kind: 'database-newer', version: '0.0.1-dev+aaaaaaaaaaaa' }
			}
		});
		expect((await fetch(`${daemon.origin}/api/daemon`)).status).toBe(403);
		expect(await readLockfile(dataDirectory)).toMatchObject({
			kind: 'lock',
			lock: { version: '0.0.1-dev+aaaaaaaaaaaa' }
		});
	});
});

describe('a daemon the call started', () => {
	it('is used, though it reports another version than the caller was given', async () => {
		const dataDirectory = await tempDirectory();
		onTestFinished(async () => {
			await stopDaemon(dataDirectory);
		});
		// As a long-running MCP shim gives the version it started with, from before a rebuild.
		const launched = await ensureDaemon(
			dataDirectory,
			version('0.0.1-dev+000000000000'),
			BUILT_COMMAND
		);
		expect(launched).toMatchObject({ ok: true, value: { found: { kind: 'own' } } });
		const lock = await readLockfile(dataDirectory);
		if (lock.kind !== 'lock' || !launched.ok) throw new Error('no daemon');
		expect(launched.value.connection.token).toBe(lock.lock.token);
		// The one daemon it started, from the command on disk, whose version that is.
		expect(lock.lock.version).toBe(await versionOnDisk(BUILT_COMMAND));
	});
});
