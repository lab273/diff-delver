import { SettingChangeSchema, type SettingsView } from '#lib/api/schemas.ts';
import { serviceFailure } from '#lib/server/api/present.ts';
import { readBody } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/** How the person likes diffs shown, kept in diff delver's database on this machine. */
export const GET: RequestHandler = ({ locals }) => {
	const body: SettingsView = locals.daemon.service.settings();
	return Response.json(body);
};

/** Changes one setting, for every diff, and gives the settings as they now are. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const change = await readBody(request, SettingChangeSchema);
	if (!change.ok) return change.error;
	const changed = locals.daemon.service.changeSetting(change.value);
	if (!changed.ok) return serviceFailure(changed.error);
	const body: SettingsView = changed.value;
	return Response.json(body);
};
