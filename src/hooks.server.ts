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
import { dev } from '$app/env';
import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import { daemonOnPort } from '#lib/server/daemon/context.ts';
import { developmentDaemon } from '#lib/server/daemon/development.ts';

export const handle: Handle = async ({ event, resolve }) => {
	const daemon = dev
		? await developmentDaemon()
		: daemonOnPort(event.platform?.req.socket.localPort);
	if (daemon === undefined) {
		return new Response(
			'This is diff delver’s app without diff delver around it. Start diff delver with the diff-delver command instead.\n',
			{ status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } }
		);
	}
	event.locals.daemon = daemon;
	return resolve(event);
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
