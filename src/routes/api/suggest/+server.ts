import type { SuggestResponse } from '#lib/api/schemas.ts';
import { parseAbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import {
	describeInvalidSourceSpec,
	parseGitSourceSpec
} from '#lib/core/sources/git-source-spec.ts';
import { badRequest, serviceFailure, suggestView } from '#lib/server/api/present.ts';
import { describeReportError } from '#lib/server/reports/index.ts';
import type { RequestHandler } from './$types';

/**
 * What could be opened in a folder, without opening anything, for the chooser;
 * with `asked`, also why that source could not be opened, if it cannot.
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
			asked = { problem: describeInvalidSourceSpec(spec.error) };
		} else {
			const checked = await locals.daemon.service.checkSource(directory.value, spec.value);
			asked = { problem: checked.ok ? null : describeReportError(checked.error) };
		}
	}
	const body: SuggestResponse = suggestView(suggested.value, asked);
	return Response.json(body);
};
