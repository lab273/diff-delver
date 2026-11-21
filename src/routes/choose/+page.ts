import { parseAbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { pageClient } from '#lib/ui/client.ts';
import type { PageLoad } from './$types';

/** The repository's branches, and the commits of the one checked out (or the first listed). */
export const load: PageLoad = async ({ fetch, url }) => {
	const path = parseAbsolutePath(url.searchParams.get('directory') ?? '');
	if (!path.ok) return { directory: undefined, history: undefined, commits: undefined };
	const client = pageClient(fetch);
	const directory = path.value;
	const history = await client.history({ directory, find: '' });
	const first = history.ok
		? (history.value.branches.find((b) => b.current) ?? history.value.branches[0])
		: undefined;
	const commits =
		first === undefined
			? undefined
			: {
					branch: first.ref,
					page: await client.commits({ directory, branch: first.ref, from: undefined })
				};
	return { directory, history, commits };
};
