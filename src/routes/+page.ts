import { pageClient } from '#lib/ui/client.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, depends }) => {
	depends('app:diffs');
	return { listed: await pageClient(fetch).listDiffs() };
};
