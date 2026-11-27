/**
 * Measuring what each Delve takes on disk (DESIGN 9.1), for the report
 * service: in the background, a store at a time, `MEASURE_AFTER_MS` after a
 * snapshot was last added to it or removed from it or it was collected, and
 * at once for every store with a Delve, or a size, not measured yet. git
 * adds up what every Delve's snapshots in the store reach, what each one's
 * reach, and what the others' reach without it
 * (`core/disk-usage/delve-sizes.ts`); a pull request's kept downloads, which
 * are its alone, add their packs' sizes to its own figure, and may hold some
 * of what its snapshots reach, so its figure may be a little high. The figures, the store's size and the
 * database's are kept in the database, so the list and the Storage page read
 * nothing else. Nothing waits for it: until a Delve is measured, nothing is
 * said of its size. The rows of the database are not counted; they are small.
 */
import { stat } from 'node:fs/promises';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { parseByteSize, type ByteSize } from '#lib/core/byte-size.tiny.ts';
import type { Clock } from '#lib/core/clock.ts';
import {
	delveSizes,
	type DelveDiskUsage,
	type DelveReach
} from '#lib/core/disk-usage/delve-sizes.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { ok, type Result } from '#lib/core/result.ts';
import type { SnapshotId } from '#lib/core/snapshot-id.tiny.ts';
import type { StoreId } from '#lib/core/store-id.tiny.ts';
import type { Database } from '../db/index.ts';
import { recordDatabaseSize } from '../db/tables/database-size.ts';
import { replaceStoreSizes, storesNotMeasured } from '../db/tables/delve-sizes.ts';
import { everyReport } from '../db/tables/reports.ts';
import { snapshotsInStore } from '../db/tables/revisions.ts';
import { recordStoreSize } from '../db/tables/store-sizes.ts';
import { fetchKey, keptFetchesIn, keptFetchSize } from '../sources/github/index.ts';
import { diskUsageOf, openStore, storeSizeOnDisk } from '../store/index.ts';
import { describeReportError, type ReportError } from './report-error.ts';

/**
 * How long, by the service's clock, after a store last changed it is
 * measured, so a Delve updated again and again is measured once it settles.
 */
export const MEASURE_AFTER_MS = 60_000;

export class DiskUsage {
	readonly #db: Database;
	readonly #dataDirectory: AbsolutePath;
	readonly #clock: Clock;
	readonly #log: (line: string) => void;
	/** Stores whose figures are out of date, with when each last changed. */
	readonly #due = new Map<StoreId, number>();
	/** Whether the stores never measured have been added to `#due`. */
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

	/** Notes that a snapshot was added to the store or removed from it, or it was collected. */
	storeChanged(store: StoreId): void {
		this.#due.set(store, this.#clock.now());
	}

	/**
	 * Measures every store whose figures are out of date and that has not
	 * changed for `MEASURE_AFTER_MS`, one at a time, after any run under way,
	 * then the database's size. Once `stop` fires, git is stopped and nothing
	 * more is measured; what was not is left due. A store that cannot be
	 * measured is said in the log and left until it next changes. Returns the
	 * stores it measured.
	 */
	measure(stop?: AbortSignal): Promise<readonly StoreId[]> {
		const run = this.#running.then(() => this.#measureDue(stop));
		this.#running = run.catch(() => undefined);
		return run;
	}

	async #measureDue(stop: AbortSignal | undefined): Promise<readonly StoreId[]> {
		if (!this.#swept) {
			const found = this.#db.read((q) => ok(storesNotMeasured(q)));
			if (found.ok) for (const store of found.value) this.#due.set(store, 0);
			this.#swept = true;
		}
		const now = this.#clock.now();
		const ready = [...this.#due].filter(([, at]) => at + MEASURE_AFTER_MS <= now);
		const measured: StoreId[] = [];
		for (const [store, at] of ready) {
			if (stop?.aborted === true) break;
			// Taken first, so a change while it is measured measures it again.
			if (this.#due.get(store) === at) this.#due.delete(store);
			const done = await this.#measureStore(store, stop);
			if (stopped(stop)) {
				if (!this.#due.has(store)) this.#due.set(store, at);
				break;
			}
			if (done.ok) measured.push(store);
			else {
				this.#log(
					`diff delver could not measure what its saved changes take on disk: ${describeReportError(done.error)}`
				);
			}
		}
		if (measured.length > 0) {
			const size = await databaseSize(this.#db.file);
			this.#db.write((q) => {
				recordDatabaseSize(q, { onDisk: size, measuredAt: this.#clock.now() });
				return ok(undefined);
			});
		}
		return measured;
	}

	async #measureStore(
		storeId: StoreId,
		stop: AbortSignal | undefined
	): Promise<Result<void, ReportError>> {
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
			return this.#db.write((q) => {
				replaceStoreSizes(q, storeId, new Map());
				recordStoreSize(q, storeId, undefined);
				return ok(undefined);
			});
		}
		const snapshots = new Map<ReportId, SnapshotId[]>();
		for (const { report, snapshot } of found.value.snapshots) {
			snapshots.set(report, [...(snapshots.get(report) ?? []), snapshot]);
		}
		// A pull request's downloads are its alone: each counts by its pack's size.
		const downloads = new Map<ReportId, number>();
		const delveOf = new Map(found.value.pullRequests.map((p) => [p.key, p.report]));
		for (const kept of await keptFetchesIn(store.value)) {
			const report = delveOf.get(kept.key);
			if (report !== undefined && snapshots.has(report)) {
				downloads.set(report, (downloads.get(report) ?? 0) + (await keptFetchSize(kept)));
			}
		}
		const reachOf = (of: readonly ReportId[]): readonly SnapshotId[] =>
			of.flatMap((d) => snapshots.get(d) ?? []);
		const delves = [...snapshots.keys()];
		const all = await diskUsageOf(store.value, reachOf(delves), stop);
		if (!all.ok) return all;
		const each = new Map<ReportId, DelveReach>();
		for (const delve of delves) {
			if (stopped(stop)) return ok(undefined);
			if (delves.length === 1) {
				each.set(delve, { reach: all.value, others: zero() });
				continue;
			}
			const reach = await diskUsageOf(store.value, reachOf([delve]), stop);
			if (!reach.ok) return reach;
			const others = await diskUsageOf(
				store.value,
				reachOf(delves.filter((d) => d !== delve)),
				stop
			);
			if (!others.ok) return others;
			each.set(delve, { reach: reach.value, others: others.value });
		}
		const sizes = new Map(
			[...delveSizes(all.value, each)].map(([delve, usage]) => [
				delve,
				withDownloads(usage, downloads.get(delve) ?? 0)
			])
		);
		const onDisk = await storeSizeOnDisk(store.value, stop);
		if (!onDisk.ok) return onDisk;
		return this.#db.write((q) => {
			replaceStoreSizes(q, storeId, sizes);
			recordStoreSize(q, storeId, {
				repository: store.value.repository,
				onDisk: onDisk.value,
				measuredAt: this.#clock.now()
			});
			return ok(undefined);
		});
	}
}

/** Whether `stop` has fired, asked again after each wait. */
function stopped(stop: AbortSignal | undefined): boolean {
	return stop?.aborted === true;
}

/** A Delve's figures with its downloads, which are its own. */
function withDownloads(usage: DelveDiskUsage, downloads: number): DelveDiskUsage {
	const own = parseByteSize(usage.own + downloads);
	return own.ok ? { ...usage, own: own.value } : usage;
}

function zero(): ByteSize {
	const none = parseByteSize(0);
	if (!none.ok) throw new Error('Nothing is a size');
	return none.value;
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
