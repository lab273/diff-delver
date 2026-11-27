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
 * The sizes are git's own on disk, which depend on how the objects were
 * compressed against each other, so the figures are estimates, said with
 * "about" (`disk-words.ts`).
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

/**
 * Each Delve's figures, from the objects each reaches (`reached`, by Delve)
 * and each object's size on disk (`sizeOf`). An object whose size is not
 * known, such as one collected while it was being measured, counts nothing.
 * Every Delve of `reached` has figures, none for a Delve it lacks.
 */
export function delveSizes<Delve, ObjectName>(
	reached: ReadonlyMap<Delve, Iterable<ObjectName>>,
	sizeOf: (object: ObjectName) => ByteSize | undefined
): ReadonlyMap<Delve, DelveDiskUsage> {
	// The one Delve that reaches each object, or `SHARED` once a second does.
	const SHARED = Symbol('shared');
	const owner = new Map<ObjectName, Delve | typeof SHARED>();
	for (const [delve, objects] of reached) {
		for (const object of objects) {
			const now = owner.get(object);
			if (now === undefined) owner.set(object, delve);
			else if (now !== delve) owner.set(object, SHARED);
		}
	}
	const own = new Map<Delve, number>();
	const shared = new Map<Delve, number>();
	for (const [delve, objects] of reached) {
		own.set(delve, 0);
		shared.set(delve, 0);
		const counted = new Set<ObjectName>();
		for (const object of objects) {
			if (counted.has(object)) continue;
			counted.add(object);
			const size = sizeOf(object) ?? 0;
			const into = owner.get(object) === SHARED ? shared : own;
			into.set(delve, (into.get(delve) ?? 0) + size);
		}
	}
	const sizes = new Map<Delve, DelveDiskUsage>();
	for (const delve of reached.keys()) {
		sizes.set(delve, { own: bytes(own.get(delve) ?? 0), shared: bytes(shared.get(delve) ?? 0) });
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
