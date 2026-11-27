/**
 * Measuring what each Delve takes on disk (DESIGN 9.1), for the report
 * service: in the background, a store at a time, after a snapshot is added
 * to it or removed from it, and once for every store with a Delve that has no
 * figure yet. A Delve's objects are those its snapshots reach and, for a pull
 * request's Delve, those in its kept downloads; `core/disk-usage/delve-sizes.ts`
 * turns them into its own and shared figures, which are kept in
 * `delve_sizes`. Nothing waits for it: until a Delve is measured, nothing is
 * said of its size. The rows of the database are not counted; they are small.
 */
import { stat } from 'node:fs/promises';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseByteSize, type ByteSize } from '#lib/core/byte-size.tiny.ts';
import type { Clock } from '#lib/core/clock.ts';
import { delveSizes, type DelveDiskUsage } from '#lib/core/disk-usage/delve-sizes.ts';
import type { ObjectId } from '#lib/core/object-id.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { ok, type Result } from '#lib/core/result.ts';
import type { SnapshotId } from '#lib/core/snapshot-id.tiny.ts';
import type { StoreId } from '#lib/core/store-id.tiny.ts';
import type { Database } from '../db/index.ts';
import { replaceStoreSizes, storesNotMeasured } from '../db/tables/delve-sizes.ts';
import { everyReport } from '../db/tables/reports.ts';
import { snapshotsInStore } from '../db/tables/revisions.ts';
import { fetchKey, keptFetchesIn, keptFetchIndex } from '../sources/github/index.ts';
import {
	objectDiskSizes,
	objectsInPack,
	objectsReachedBy,
	openStore,
	type Store
} from '../store/index.ts';
import { describeReportError, type ReportError } from './report-error.ts';

export class DiskUsage {
	readonly #db: Database;
	readonly #dataDirectory: AbsolutePath;
	readonly #clock: Clock;
	readonly #log: (line: string) => void;
	/** Stores whose figures are out of date. */
	readonly #due = new Set<StoreId>();
	/** Whether the stores with a Delve never measured have been added to `#due`. */
	#swept = false;
	/** The run under way, so that two never measure at once. */
	#running: Promise<unknown> = Promise.resolve();

	constructor(
		db: Database,
		dataDirectory: AbsolutePath,
		clock: Clock,
		log: (line: string) => void
	) {
		this.#db = db;
		this.#dataDirectory = dataDirectory;
		this.#clock = clock;
		this.#log = log;
	}

	/** Notes that a snapshot was added to the store or removed from it. */
	storeChanged(store: StoreId): void {
		this.#due.add(store);
	}

	/**
	 * Measures every store whose figures are out of date, one at a time, after
	 * any run under way; stops before the next store once `stop` fires. A store
	 * that cannot be measured is said in the log and left until it next
	 * changes. Returns the stores it measured.
	 */
	measure(stop?: AbortSignal): Promise<readonly StoreId[]> {
		const run = this.#running.then(() => this.#measureDue(stop));
		this.#running = run.catch(() => undefined);
		return run;
	}

	async #measureDue(stop: AbortSignal | undefined): Promise<readonly StoreId[]> {
		if (!this.#swept) {
			const found = this.#db.read((q) => ok(storesNotMeasured(q)));
			if (found.ok) for (const store of found.value) this.#due.add(store);
			this.#swept = true;
		}
		const measured: StoreId[] = [];
		while (this.#due.size > 0 && stop?.aborted !== true) {
			const next = this.#due.values().next();
			if (next.done === true) break;
			const store = next.value;
			// Taken first, so a change while it is measured measures it again.
			this.#due.delete(store);
			const done = await this.#measureStore(store);
			if (done.ok) measured.push(store);
			else {
				this.#log(
					`diff delver could not measure what its saved changes take on disk: ${describeReportError(done.error)}`
				);
			}
		}
		return measured;
	}

	async #measureStore(storeId: StoreId): Promise<Result<void, ReportError>> {
		const found = this.#db.read((q) =>
			ok({
				snapshots: snapshotsInStore(q, storeId),
				pullRequests: everyReport(q).flatMap((row) =>
					row.ok && row.value.source.kind === 'github'
						? [{ report: row.value.id, key: fetchKey(row.value.source.pullRequest) }]
						: []
				)
			})
		);
		if (!found.ok) return found;
		const store = await openStore(this.#dataDirectory, storeId);
		if (!store.ok) {
			if (store.error.kind !== 'StoreNotFound') return store;
			return this.#record(storeId, new Map());
		}
		const byDelve = new Map<ReportId, SnapshotId[]>();
		for (const { report, snapshot } of found.value.snapshots) {
			byDelve.set(report, [...(byDelve.get(report) ?? []), snapshot]);
		}
		const reached = new Map<ReportId, ObjectId[]>();
		for (const [report, snapshots] of byDelve) {
			const objects = await objectsReachedBy(store.value, snapshots);
			if (!objects.ok) return objects;
			reached.set(report, [...objects.value]);
		}
		const downloads = await this.#downloadsOf(store.value, found.value.pullRequests, reached);
		if (!downloads.ok) return downloads;
		const sizes = await objectDiskSizes(store.value);
		if (!sizes.ok) return sizes;
		return this.#record(
			storeId,
			delveSizes(reached, (object) => sizes.value.get(object))
		);
	}

	/** Adds to each pull request's Delve in `reached` the objects of its kept downloads. */
	async #downloadsOf(
		store: Store,
		pullRequests: readonly { readonly report: ReportId; readonly key: string }[],
		reached: Map<ReportId, ObjectId[]>
	): Promise<Result<void, ReportError>> {
		const delveOf = new Map(
			pullRequests.filter((p) => reached.has(p.report)).map((p) => [p.key, p.report])
		);
		if (delveOf.size === 0) return ok(undefined);
		for (const kept of await keptFetchesIn(store)) {
			const report = delveOf.get(kept.key);
			if (report === undefined) continue;
			const objects = await objectsInPack(store, keptFetchIndex(kept));
			if (!objects.ok) return objects;
			const into = reached.get(report);
			for (const object of into === undefined ? [] : objects.value) into?.push(object);
		}
		return ok(undefined);
	}

	#record(store: StoreId, sizes: ReadonlyMap<ReportId, DelveDiskUsage>): Result<void, ReportError> {
		return this.#db.write((q) => {
			replaceStoreSizes(q, store, sizes, this.#clock.now());
			return ok(undefined);
		});
	}
}

/** The database's size on disk: its file and the files SQLite keeps beside it. */
export async function databaseSize(file: AbsolutePath): Promise<ByteSize> {
	let total = 0;
	for (const path of [file, `${file}-wal`, `${file}-shm`]) {
		total += (await stat(path).catch(() => undefined))?.size ?? 0;
	}
	const size = parseByteSize(total);
	if (!size.ok) throw new Error('Files add up to no size');
	return size.value;
}
