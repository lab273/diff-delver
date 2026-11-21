/**
 * The `settings` table: how the person likes the diff drawn (`core/settings.ts`),
 * one row per setting they have changed; a setting with no row has its
 * default. The only code that sees its rows.
 */
import { z } from 'zod';
import {
	DEFAULT_SETTINGS,
	withSetting,
	type SettingChange,
	type ViewSettings
} from '#lib/core/settings.ts';
import { ok, type Result } from '#lib/core/result.ts';
import { parseRows } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

const row = z.discriminatedUnion('name', [
	z.object({
		name: z.literal('colours'),
		value: z.enum(['on', 'off']).transform((v) => v === 'on')
	}),
	z.object({ name: z.literal('layout'), value: z.enum(['unified', 'side-by-side']) })
]);

/** The settings as stored: the defaults, with every row's change. */
export function readSettings(q: Queries): Result<ViewSettings, StoredRowInvalid> {
	const rows = parseRows('settings', row, q.all('SELECT name, value FROM settings ORDER BY name'));
	if (!rows.ok) return rows;
	return ok(rows.value.reduce(withSetting, DEFAULT_SETTINGS));
}

/** A setting's value as its row holds it. */
function stored(change: SettingChange): string {
	switch (change.name) {
		case 'colours':
			return change.value ? 'on' : 'off';
		case 'layout':
			return change.value;
	}
}

/** Stores one setting, replacing what was stored for it. */
export function writeSetting(q: Queries, change: SettingChange): void {
	q.run(
		'INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value',
		change.name,
		stored(change)
	);
}
