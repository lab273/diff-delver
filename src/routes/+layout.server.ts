import { canReview } from '#lib/server/api/review-session.ts';
import type { LayoutServerLoad } from './$types';

/** Asked again, by this name, when a page thinks its browser may have been let write drafts since. */
export const load: LayoutServerLoad = ({ locals, request, depends }) => {
	depends('app:review-access');
	return { canReview: canReview(locals.daemon, request) };
};
