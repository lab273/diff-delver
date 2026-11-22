import { error } from '@sveltejs/kit';
import { parseReportId } from '#lib/core/report-id.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { DEFAULT_SETTINGS } from '#lib/core/settings.ts';
import { pageClient } from '#lib/ui/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, depends, url }) => {
	depends('app:diff');
	const id = parseReportId(params.id);
	if (!id.ok) error(404, 'There is no Delve at this address.');
	const client = pageClient(fetch);
	const pinned = url.searchParams.get('version');
	const version = pinned === null ? undefined : parseRevisionNumber(Number(pinned));
	if (version?.ok === false) error(400, 'This Delve version is not a valid number.');
	const [loaded, settings] = await Promise.all([
		client.loadDiff(id.value, 'sections', version?.value),
		client.readSettings()
	]);
	// Settings that cannot be read are the defaults: the diff can still be read.
	return {
		id: id.value,
		loaded,
		requestedVersion: pinned,
		settings: settings.ok ? settings.value : DEFAULT_SETTINGS
	};
};
