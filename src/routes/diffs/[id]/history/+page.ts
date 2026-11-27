import { error } from '@sveltejs/kit';
import { parseReportId } from '#lib/core/report-id.tiny.ts';
import { pageClient } from '#lib/ui/client.ts';
import type { PageLoad } from './$types';

/** A Delve's history: its versions and finished reviews, in the order they happened. */
export const load: PageLoad = async ({ fetch, params }) => {
	const id = parseReportId(params.id);
	if (!id.ok) error(404, 'There is no Delve at this address.');
	return { id: id.value, history: await pageClient(fetch).delveHistory(id.value) };
};
