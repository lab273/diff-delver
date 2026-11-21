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
	z.object({ name: z.literal('colours'), value: z.enum(['on', 'off']) })
]);

/** The settings as stored: the defaults, with every row's change. */
export function readSettings(q: Queries): Result<ViewSettings, StoredRowInvalid> {
	const rows = parseRows('settings', row, q.all('SELECT name, value FROM settings ORDER BY name'));
	if (!rows.ok) return rows;
	let settings = DEFAULT_SETTINGS;
	for (const stored of rows.value) {
		settings = withSetting(settings, { name: stored.name, value: stored.value === 'on' });
	}
	return ok(settings);
}

/** Stores one setting, replacing what was stored for it. */
export function writeSetting(q: Queries, change: SettingChange): void {
	const value = change.value ? 'on' : 'off';
	q.run(
		'INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value',
		change.name,
		value
	);
}
