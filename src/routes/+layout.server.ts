import { canReview } from '#lib/server/api/review-session.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, request }) => ({
	canReview: canReview(locals.daemon, request)
});
