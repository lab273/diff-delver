import { StopRequestSchema, type Stopping } from '#lib/api/schemas.ts';
import type { StopReason } from '#lib/core/daemon/stop-reason.ts';
import type { RequestHandler } from './$types';

/**
 * Stops the daemon once this answer is sent: `diff-delver stop`, or another
 * copy of diff delver replacing it. Why goes in its log; a command older than
 * this says nothing of why, and is still obeyed.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const why = StopRequestSchema.safeParse(await request.json().catch(() => undefined));
	const reason: StopReason = !why.success
		? { kind: 'asked' }
		: why.data.by.kind === 'command'
			? { kind: 'command' }
			: { kind: 'replaced', by: why.data.by.version };
	locals.daemon.requestStop(reason);
	const body: Stopping = { stopping: true };
	return Response.json(body);
};
