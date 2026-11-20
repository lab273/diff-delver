/**
 * Loads the app from the production build. The daemon serves it; nothing is
 * loaded until a daemon starts, so `diff-delver --help` needs no build.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export type AppHandler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

export async function loadAppHandler(): Promise<AppHandler> {
	const app = await import('#build/handler.js');
	return app.handler;
}
