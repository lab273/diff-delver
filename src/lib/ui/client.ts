/**
 * The API client as the pages use it: in a load function with SvelteKit's
 * `fetch`, so a page rendered on the server asks the daemon in-process, and in
 * the browser with the page's own, whose cookie carries the token.
 */
import { ApiClient } from '#lib/api/client.ts';

export function pageClient(fetcher: typeof fetch = fetch): ApiClient {
	return new ApiClient({ fetch: fetcher, base: '' });
}
