/**
 * Finds the daemon serving each request (`#lib/server/daemon/context.ts`) and
 * hands it to the routes as `locals.daemon`. The daemon's own HTTP server has
 * already checked the request's host, origin and token before the app sees it
 * (`#lib/server/daemon/http-server.ts`).
 *
 * The app on its own, as `node build` would run it, has no daemon and serves
 * nothing but a page saying how to start diff delver. `pnpm dev` makes a daemon
 * context of its own for the machine's data folder, with no token, for working
 * on the pages.
 */
import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import { daemonOnPort } from '#lib/server/daemon/context.ts';
import {
	GIVE_UP_AFTER_MS,
	READY_ATTRIBUTE,
	earlyKeyOf,
	keepEarlyKeys
} from '#lib/ui/early-input.ts';
import { SHORTCUTS } from '#lib/ui/viewer/keys.ts';

/** Where src/app.html takes the script that keeps keys pressed before the page is ready. */
const EARLY_KEYS_PLACE = '%diff-delver.early-keys%';

/** The pages with keyboard shortcuts of their own. */
const PAGES_WITH_SHORTCUTS: ReadonlySet<string> = new Set(['/diffs/[id]']);

/**
 * The script that keeps keys pressed before the page is ready, as the page's
 * head runs it, before any module has loaded: `keepEarlyKeys` and its rule,
 * written out as they are in src/lib/ui/early-input.ts, so the rule tested
 * there is the one the page runs.
 */
function earlyKeysScript(routeId: string | null): string {
	const shortcuts =
		routeId !== null && PAGES_WITH_SHORTCUTS.has(routeId) ? SHORTCUTS.flatMap((s) => s.keys) : [];
	const args = [
		earlyKeyOf.toString(),
		JSON.stringify(shortcuts),
		JSON.stringify(READY_ATTRIBUTE),
		String(GIVE_UP_AFTER_MS)
	];
	const script = `(${keepEarlyKeys.toString()})(${args.join(', ')});`;
	// Our own code, but it must never close the element it is written into.
	if (script.toLowerCase().includes('</script'))
		throw new Error('The early-keys script closes itself');
	return script;
}

export const handle: Handle = async ({ event, resolve }) => {
	// Imported only in development, so the app's build carries no daemon of its own:
	// the daemon is the command's, which serves the app.
	const daemon = import.meta.env.DEV
		? await (await import('#lib/server/daemon/development.ts')).developmentDaemon()
		: daemonOnPort(event.platform?.req.socket.localPort);
	if (daemon === undefined) {
		return new Response(
			'This is diff delver’s app without diff delver around it. Start diff delver with the diff-delver command instead.\n',
			{ status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } }
		);
	}
	event.locals.daemon = daemon;
	const script = earlyKeysScript(event.route.id);
	return resolve(event, {
		transformPageChunk: ({ html }) => html.replace(EARLY_KEYS_PLACE, () => script)
	});
};

/**
 * An error nothing expected, such as a bug: written where the daemon writes
 * (`daemon.log` in the data folder, when the command started it), and shown to
 * the reviewer in plain words.
 */
export const handleError: HandleServerError = (caught) => {
	switch (caught.kind) {
		case 'unknown':
			console.error('diff delver hit an error it did not expect:', caught.error);
			return {
				message:
					'Something went wrong in diff delver. Reload the page; if it keeps happening, please report it as a bug.'
			};
		case 'framework':
			return caught.error.status === 404
				? { message: 'There is no page at this address.' }
				: undefined;
		case 'app':
		case 'validation':
			return undefined;
	}
};
