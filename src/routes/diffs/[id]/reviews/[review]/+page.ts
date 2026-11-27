import { error } from '@sveltejs/kit';
import { parseReportId } from '#lib/core/report-id.tiny.ts';
import { parseReviewNumber } from '#lib/core/review-number.tiny.ts';
import { pageClient } from '#lib/ui/client.ts';
import type { PageLoad } from './$types';

/** One finished review of a Delve, read-only. */
export const load: PageLoad = async ({ fetch, params, depends }) => {
	depends('app:past-review');
	const id = parseReportId(params.id);
	if (!id.ok) error(404, 'There is no Delve at this address.');
	const number = parseReviewNumber(Number(params.review));
	if (!number.ok) error(404, 'There is no such review of this Delve.');
	return {
		id: id.value,
		number: number.value,
		review: await pageClient(fetch).pastReview(id.value, number.value)
	};
};
