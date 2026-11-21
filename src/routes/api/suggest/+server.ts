import type { SuggestResponse } from '#lib/api/schemas.ts';
import { parseAbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import {
	describeInvalidSourceSpec,
	parseGitSourceSpec
} from '#lib/core/sources/git-source-spec.ts';
import { badRequest, serviceFailure, suggestView } from '#lib/server/api/present.ts';
import { describeReportError } from '#lib/server/reports/report-error.ts';
import type { RequestHandler } from './$types';

/**
 * What could be opened in a folder, without opening anything, for the start page's choice;
 * with `asked`, also why that source could not be opened, if it cannot, or
 * whether it has anything to review.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	const directory = parseAbsolutePath(url.searchParams.get('directory') ?? '');
	if (!directory.ok) return badRequest('the folder is not a full path');
	const suggested = await locals.daemon.service.suggest(directory.value);
	if (!suggested.ok) return serviceFailure(suggested.error);
	const askedText = url.searchParams.get('asked');
	let asked: SuggestResponse['asked'] = null;
	if (askedText !== null) {
		const spec = parseGitSourceSpec(askedText);
		if (!spec.ok) {
			asked = { problem: describeInvalidSourceSpec(spec.error), changes: false };
		} else {
			const checked = await locals.daemon.service.checkSource(directory.value, spec.value);
			asked = checked.ok
				? { problem: null, changes: checked.value === 'changes' }
				: { problem: describeReportError(checked.error), changes: false };
		}
	}
	const body: SuggestResponse = suggestView(suggested.value, asked);
	return Response.json(body);
};
