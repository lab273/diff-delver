import { error } from '@sveltejs/kit';
import { parseReportId } from '#lib/core/report-id.tiny.ts';
import { pageClient } from '#lib/ui/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, depends }) => {
	depends('app:diff');
	const id = parseReportId(params.id);
	if (!id.ok) error(404, 'There is no diff at this address.');
	return { id: id.value, loaded: await pageClient(fetch).loadDiff(id.value) };
};
