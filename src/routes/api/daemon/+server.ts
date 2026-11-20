import type { DaemonInfo } from '#lib/api/schemas.ts';
import { parseProcessId } from '#lib/core/process-id.tiny.ts';
import type { RequestHandler } from './$types';

/**
 * Which build the daemon runs, so the command can tell whether it can use it,
 * and which process it is, so the command never signals a process that is not
 * this daemon.
 */
export const GET: RequestHandler = ({ locals }) => {
	const pid = parseProcessId(process.pid);
	if (!pid.ok) throw new Error('This process has no id.');
	const body: DaemonInfo = { version: locals.daemon.version, pid: pid.value };
	return Response.json(body);
};
