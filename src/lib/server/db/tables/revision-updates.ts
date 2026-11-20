/**
 * The `revision_updates` table: what the update that made a revision did
 * (DESIGN 6.2), one row for each revision an update made. The only code that
 * sees its rows.
 */
import { z } from 'zod';
import { parseFileCount } from '#lib/core/file-count.tiny.ts';
import { map, ok, type Result } from '#lib/core/result.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import { parseUnitCount } from '#lib/core/unit-count.tiny.ts';
import type { UpdateSummary } from '#lib/core/update/update-summary.ts';
import { parseRow, whole } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

const COLUMNS =
	'files_changed, files_gone, new_to_review, new_ignored, gone_units, reviewed_before, reviewed_kept';

const files = whole(parseFileCount);
const units = whole(parseUnitCount);

const row = z.object({
	files_changed: files,
	files_gone: files,
	new_to_review: units,
	new_ignored: units,
	gone_units: units,
	reviewed_before: units,
	reviewed_kept: units
});

/** Records what the update that made `revision` did. */
export function insertRevisionUpdate(
	q: Queries,
	revision: RevisionId,
	summary: UpdateSummary
): void {
	q.run(
		`INSERT INTO revision_updates (revision_id, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		revision,
		summary.filesChanged,
		summary.filesGone,
		summary.newToReview,
		summary.newIgnored,
		summary.gone,
		summary.reviewedBefore,
		summary.reviewedKept
	);
}

/** What the update that made `revision` did; undefined for a revision no update made. */
export function revisionUpdateFor(
	q: Queries,
	revision: RevisionId
): Result<UpdateSummary | undefined, StoredRowInvalid> {
	const raw = q.get(`SELECT ${COLUMNS} FROM revision_updates WHERE revision_id = ?`, revision);
	if (raw === undefined) return ok(undefined);
	return map(parseRow('revision_updates', row, raw), (r) => ({
		filesChanged: r.files_changed,
		filesGone: r.files_gone,
		newToReview: r.new_to_review,
		newIgnored: r.new_ignored,
		gone: r.gone_units,
		reviewedBefore: r.reviewed_before,
		reviewedKept: r.reviewed_kept
	}));
}
