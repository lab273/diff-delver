import { error } from '@sveltejs/kit';
import { parseReportId } from '#lib/core/report-id.tiny.ts';
import { DEFAULT_SETTINGS } from '#lib/core/settings.ts';
import { pageClient } from '#lib/ui/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, depends }) => {
	depends('app:diff');
	const id = parseReportId(params.id);
	if (!id.ok) error(404, 'There is no diff at this address.');
	const client = pageClient(fetch);
	const [loaded, settings] = await Promise.all([client.loadDiff(id.value), client.readSettings()]);
	// Settings that cannot be read are the defaults: the diff can still be read.
	return { id: id.value, loaded, settings: settings.ok ? settings.value : DEFAULT_SETTINGS };
};
