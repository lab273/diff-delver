import { canReview } from '#lib/server/api/review-session.ts';
import type { LayoutServerLoad } from './$types';

/**
 * Asked again, by this name, when a page thinks its browser may have been let
 * write drafts since. With the version of the daemon that served it, which a
 * page keeps from when it was first loaded (`DaemonReplaced.svelte`), and which
 * build it is, with the daemon's time, for the header.
 */
export const load: LayoutServerLoad = ({ locals, request, depends }) => {
	depends('app:review-access');
	return {
		canReview: canReview(locals.daemon, request),
		daemonVersion: locals.daemon.version,
		build: locals.daemon.build,
		now: locals.daemon.clock.now()
	};
};
