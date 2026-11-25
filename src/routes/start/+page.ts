import { parseSourceSpec } from '#lib/core/sources/source-spec.ts';
import { pageClient } from '#lib/ui/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const directory = url.searchParams.get('directory') ?? '';
	const askedText = url.searchParams.get('asked') ?? undefined;
	// The start page explains git sources; a pull request is offered on the choose page.
	const asked = parseSourceSpec(askedText ?? '');
	return {
		directory,
		asked: asked.ok && asked.value.kind !== 'pull-request' ? asked.value : undefined,
		suggested: await pageClient(fetch).suggest(directory, askedText)
	};
};
