/**
 * The `delve_sizes` table: what each Delve takes on disk in each store it has
 * snapshots in, as last measured (DESIGN 9.1). A Delve with no row has not
 * been measured yet. A row that cannot be read is left out, as if it had not
 * been measured. The only code that sees its rows.
 */
import { z } from 'zod';
import { parseByteSize } from '#lib/core/byte-size.tiny.ts';
import type { DelveDiskUsage } from '#lib/core/disk-usage/delve-sizes.ts';
import { parseReportId, type ReportId } from '#lib/core/report-id.tiny.ts';
import { parseStoreId, type StoreId } from '#lib/core/store-id.tiny.ts';
import { parseRow, text, whole } from '../columns.ts';
import type { Queries, RawRow } from '../database.ts';

const row = z.object({
	report_id: text(parseReportId),
	store_id: text(parseStoreId),
	own_bytes: whole(parseByteSize),
	shared_bytes: whole(parseByteSize)
});

const storeOnly = z.object({ store_id: text(parseStoreId) });

/** What a Delve takes in one store. */
export interface StoredDelveSize {
	readonly report: ReportId;
	readonly store: StoreId;
	readonly usage: DelveDiskUsage;
}

function parsedRows(raws: readonly RawRow[]): readonly StoredDelveSize[] {
	return raws.flatMap((raw) => {
		const parsed = parseRow('delve_sizes', row, raw);
		if (!parsed.ok) return [];
		const { report_id, store_id, own_bytes, shared_bytes } = parsed.value;
		return [
			{ report: report_id, store: store_id, usage: { own: own_bytes, shared: shared_bytes } }
		];
	});
}

/** Every Delve's figures, in every store. */
export function everyDelveSize(q: Queries): readonly StoredDelveSize[] {
	return parsedRows(q.all('SELECT report_id, store_id, own_bytes, shared_bytes FROM delve_sizes'));
}

/** One Delve's figures, in every store it has been measured in. */
export function delveSizesOf(q: Queries, report: ReportId): readonly StoredDelveSize[] {
	return parsedRows(
		q.all(
			'SELECT report_id, store_id, own_bytes, shared_bytes FROM delve_sizes WHERE report_id = ?',
			report
		)
	);
}

/**
 * Replaces the figures of every Delve in `store` with `sizes`: a Delve no
 * longer in it loses its row, and one deleted meanwhile gets none.
 */
export function replaceStoreSizes(
	q: Queries,
	store: StoreId,
	sizes: ReadonlyMap<ReportId, DelveDiskUsage>
): void {
	q.run('DELETE FROM delve_sizes WHERE store_id = ?', store);
	for (const [report, usage] of sizes) {
		q.run(
			`INSERT INTO delve_sizes (report_id, store_id, own_bytes, shared_bytes)
			 SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM reports WHERE id = ?)`,
			report,
			store,
			usage.own,
			usage.shared,
			report
		);
	}
}

/**
 * The stores with a Delve whose figures there have not been measured, or
 * whose own size has not been.
 */
export function storesNotMeasured(q: Queries): readonly StoreId[] {
	return q
		.all(
			`SELECT DISTINCT v.store_id FROM revisions AS v
			 WHERE NOT EXISTS (
				SELECT 1 FROM delve_sizes AS s
				WHERE s.report_id = v.report_id AND s.store_id = v.store_id
			 ) OR NOT EXISTS (SELECT 1 FROM store_sizes AS t WHERE t.store_id = v.store_id)`
		)
		.flatMap((raw) => {
			const parsed = parseRow('delve_sizes', storeOnly, raw);
			return parsed.ok ? [parsed.value.store_id] : [];
		});
}
