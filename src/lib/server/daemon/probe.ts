/**
 * Whether the daemon a lockfile names is there: its process exists, and a
 * daemon answers at its port, with its token, saying it is that process. A
 * lockfile whose daemon is not there is stale, left by a daemon that crashed or
 * was killed, and can be replaced; the process it names may by now be any other
 * program, so only a daemon that answers is ever sent a signal.
 */
import { ApiClient } from '#lib/api/client.ts';
import type { CodeVersion } from '#lib/core/code-version.tiny.ts';
import type { ProcessId } from '#lib/core/process-id.tiny.ts';
import type { Lock } from './lockfile.ts';

export type Probe =
	{ readonly kind: 'answering'; readonly version: CodeVersion } | { readonly kind: 'gone' };

/** How long a daemon has to answer before it counts as gone. */
const ANSWER_WITHIN_MS = 3000;

export function processExists(pid: ProcessId): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists, as another user's process.
		return error instanceof Error && 'code' in error && error.code === 'EPERM';
	}
}

export function clientFor(
	lock: Pick<Lock, 'port' | 'token'>,
	timeoutMs = ANSWER_WITHIN_MS
): ApiClient {
	return new ApiClient({
		fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
		base: `http://127.0.0.1:${String(lock.port)}`,
		token: lock.token
	});
}

export async function probeLock(lock: Lock): Promise<Probe> {
	if (!processExists(lock.pid)) return { kind: 'gone' };
	const info = await clientFor(lock).daemonInfo();
	return info.ok && info.value.pid === lock.pid
		? { kind: 'answering', version: info.value.version }
		: { kind: 'gone' };
}
