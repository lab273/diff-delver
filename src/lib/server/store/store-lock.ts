/**
 * Keeps a store's garbage collection away from everything else done to it.
 *
 * git already makes each object write and each ref update atomic, so snapshots
 * taken, read and deleted at the same time need nothing more: objects are written
 * by rename, a ref is created only if absent, and a snapshot being read keeps its
 * objects even if its ref is deleted meanwhile. The one danger is collection with
 * no grace period, which could delete objects a snapshot being taken has written
 * but not yet pinned. So every use of a store holds it shared, and collection
 * holds it exclusively.
 *
 * The lock is per process, keyed by the store's directory: one daemon serves a
 * user (DESIGN 3), and only it collects garbage.
 */
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';

type Mode = 'shared' | 'exclusive';

interface LockState {
	shared: number;
	exclusive: boolean;
	readonly waiting: { readonly mode: Mode; readonly start: () => void }[];
}

const locks = new Map<string, LockState>();

function stateOf(key: string): LockState {
	let state = locks.get(key);
	if (state === undefined) {
		state = { shared: 0, exclusive: false, waiting: [] };
		locks.set(key, state);
	}
	return state;
}

function canStart(state: LockState, mode: Mode): boolean {
	return mode === 'shared' ? !state.exclusive : !state.exclusive && state.shared === 0;
}

/** Starts waiters in order; a waiting exclusive holder blocks shared ones behind it. */
function wake(key: string, state: LockState): void {
	for (let next = state.waiting[0]; next !== undefined; next = state.waiting[0]) {
		if (!canStart(state, next.mode)) break;
		state.waiting.shift();
		if (next.mode === 'shared') state.shared += 1;
		else state.exclusive = true;
		next.start();
	}
	if (state.shared === 0 && !state.exclusive && state.waiting.length === 0) locks.delete(key);
}

/** Runs `work` while holding the store in the given mode, and releases it however `work` ends. */
export async function withStoreLock<T>(
	store: AbsolutePath,
	mode: Mode,
	work: () => Promise<T>
): Promise<T> {
	const state = stateOf(store);
	if (state.waiting.length === 0 && canStart(state, mode)) {
		if (mode === 'shared') state.shared += 1;
		else state.exclusive = true;
	} else {
		await new Promise<void>((start) => {
			state.waiting.push({ mode, start });
		});
	}
	try {
		return await work();
	} finally {
		if (mode === 'shared') state.shared -= 1;
		else state.exclusive = false;
		wake(store, state);
	}
}
