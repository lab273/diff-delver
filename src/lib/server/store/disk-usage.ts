/**
 * What a store's objects take on disk (DESIGN 9.1), for the figures of each
 * Delve (`#lib/core/disk-usage/delve-sizes.ts`): the size on disk of what
 * some snapshots reach, by git's own measure, and the store's
 * whole size. git adds them up itself, so nothing is listed object by object.
 * Each holds the store shared, so a collection waits for it, and stops git
 * when `stop` fires; between two of them the store may be collected, which
 * only makes an estimate a little off.
 */
import { parseByteSize, type ByteSize } from '#lib/core/byte-size.tiny.ts';
import { err, type Result } from '#lib/core/result.ts';
import type { SnapshotId } from '#lib/core/snapshot-id.tiny.ts';
import { runGitText } from '../git/run-git.ts';
import { SNAPSHOT_REFS } from './snapshots.ts';
import type { Store } from './store.ts';
import type { StoreError } from './store-error.ts';
import { withStoreLock } from './store-lock.ts';

function bytes(store: Store, value: number, what: string): Result<ByteSize, StoreError> {
	const size = parseByteSize(value);
	return size.ok
		? size
		: err({ kind: 'StoreDamaged', store: store.id, detail: `git gave no size for ${what}` });
}

/**
 * The size on disk of every object the snapshots reach, each counted once: a
 * loose object's file, or its entry in a pack, which for an object stored as
 * a delta against another is the delta's size. A snapshot gone meanwhile
 * reaches nothing, and an object missing from the store counts nothing, so
 * one damaged object never stops the rest being measured.
 */
export function diskUsageOf(
	store: Store,
	snapshots: readonly SnapshotId[],
	stop?: AbortSignal
): Promise<Result<ByteSize, StoreError>> {
	const tips = snapshots.map((id) => `${SNAPSHOT_REFS}${id}`);
	if (tips.length === 0) return Promise.resolve(bytes(store, 0, 'nothing'));
	return withStoreLock(store.dir, 'shared', async () => {
		const measured = await runGitText({
			cwd: store.dir,
			args: [
				'rev-list',
				'--objects',
				'--no-walk',
				'--disk-usage',
				'--ignore-missing',
				'--missing=allow-any',
				'--stdin'
			],
			input: tips.map((tip) => `${tip}\n`).join(''),
			...(stop === undefined ? {} : { stopWhen: stop })
		});
		return measured.ok ? bytes(store, Number(measured.value.trim()), 'its objects') : measured;
	});
}

/**
 * The store's size on disk, as git counts it: its loose objects, its packs
 * and what is left over in its pack folder.
 */
export function storeSizeOnDisk(
	store: Store,
	stop?: AbortSignal
): Promise<Result<ByteSize, StoreError>> {
	return withStoreLock(store.dir, 'shared', async () => {
		const counted = await runGitText({
			cwd: store.dir,
			args: ['count-objects', '-v'],
			...(stop === undefined ? {} : { stopWhen: stop })
		});
		if (!counted.ok) return counted;
		let kib = 0;
		for (const line of counted.value.split('\n')) {
			const [name = '', value = ''] = line.split(': ');
			if (name === 'size' || name === 'size-pack' || name === 'size-garbage') kib += Number(value);
		}
		return bytes(store, kib * 1024, 'the store');
	});
}
