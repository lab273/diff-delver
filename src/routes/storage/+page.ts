import { pageClient } from '#lib/ui/client.ts';
import type { PageLoad } from './$types';

/** What diff delver takes on disk: the database and each repository's store, with its Delves. */
export const load: PageLoad = async ({ fetch, depends }) => {
	depends('app:diffs');
	return { storage: await pageClient(fetch).storage() };
};
