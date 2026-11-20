import { parseGitSourceSpec } from '#lib/core/sources/git-source-spec.ts';
import { pageClient } from '#lib/ui/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const directory = url.searchParams.get('directory') ?? '';
	const asked = parseGitSourceSpec(url.searchParams.get('asked') ?? '');
	return {
		directory,
		asked: asked.ok ? asked.value : undefined,
		suggested: await pageClient(fetch).suggest(directory)
	};
};
