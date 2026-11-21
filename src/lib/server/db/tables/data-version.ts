/**
 * SQLite's `data_version`: a number that changes whenever another connection,
 * such as a second copy of diff delver, has committed a change to the
 * database since this connection last looked. This connection's own changes
 * leave it as it is. The only code that reads it.
 */
import { z } from 'zod';
import { integer } from '../columns.ts';
import type { Queries } from '../database.ts';

const row = z.object({ data_version: integer });

/**
 * What other connections have written, as a number that changes when they
 * write; undefined in the unlikely case SQLite gives none, which a caller
 * takes as a change.
 */
export function writesElsewhere(q: Queries): number | undefined {
	const parsed = row.safeParse(q.get('PRAGMA data_version'));
	return parsed.success ? parsed.data.data_version : undefined;
}
