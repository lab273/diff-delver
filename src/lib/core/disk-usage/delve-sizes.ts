/**
 * What each Delve takes on disk in a store, and what deleting it frees
 * (DESIGN 9.1), pure. The objects of a store each belong to the Delves that
 * reach them, through their snapshots or, for a pull request, its kept
 * downloads. A Delve's own figure is the size of the objects it alone
 * reaches, which deleting it frees once the store is collected; its shared
 * figure is the size of those another Delve of the store reaches too, which
 * stay. An object no Delve reaches belongs to none: it is waiting to be
 * collected. Each object counts once per Delve however many of its snapshots
 * reach it.
 *
 * git adds up the sizes itself: what every Delve of the store reaches, what
 * each Delve reaches, and what all the others reach without it. What a Delve
 * alone reaches is then the first less the last, and what it shares the rest
 * of its reach.
 *
 * The sizes are git's own on disk, which depend on how the objects were
 * compressed against each other: an object stored as a delta against another
 * counts the delta's size, though deleting that other would leave it to be
 * stored whole. So the figures are estimates, said with "about"
 * (`disk-words.ts`).
 */
import { parseByteSize, type ByteSize } from '../byte-size.tiny.ts';

/** What one Delve takes on disk in a store. */
export interface DelveDiskUsage {
	/** What deleting it frees: what it alone reaches. */
	readonly own: ByteSize;
	/** What it reaches that another Delve of the store reaches too. */
	readonly shared: ByteSize;
}

function bytes(value: number): ByteSize {
	const parsed = parseByteSize(value);
	if (!parsed.ok) throw new Error(`Not a size in bytes: ${String(value)}`);
	return parsed.value;
}

/** No space at all. */
export const NO_DISK_USAGE: DelveDiskUsage = { own: bytes(0), shared: bytes(0) };

/** What git measured for one Delve of a store. */
export interface DelveReach {
	/** What its snapshots and downloads reach. */
	readonly reach: ByteSize;
	/** What every other Delve of the store reaches, without it. */
	readonly others: ByteSize;
}

/**
 * Each Delve's figures, from what every Delve of the store reaches together
 * (`all`) and each Delve's `DelveReach`. Measured at slightly different
 * moments, the figures can disagree a little; none is ever below nothing.
 */
export function delveSizes<Delve>(
	all: ByteSize,
	each: ReadonlyMap<Delve, DelveReach>
): ReadonlyMap<Delve, DelveDiskUsage> {
	const sizes = new Map<Delve, DelveDiskUsage>();
	for (const [delve, { reach, others }] of each) {
		const own = Math.min(reach, Math.max(0, all - others));
		sizes.set(delve, { own: bytes(own), shared: bytes(reach - own) });
	}
	return sizes;
}

/** A Delve's figures over every store it is in, added up. */
export function totalDiskUsage(parts: readonly DelveDiskUsage[]): DelveDiskUsage {
	return parts.reduce(
		(total, part) => ({
			own: bytes(total.own + part.own),
			shared: bytes(total.shared + part.shared)
		}),
		NO_DISK_USAGE
	);
}
