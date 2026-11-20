/**
 * The daemon's HTTP server: every request passes the gate (`#lib/core/daemon/
 * request-gate.ts`) before the app sees it. A refused page says in plain words
 * how to open diff delver; a refused API call answers with the same message as
 * JSON.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ApiErrorBody } from '#lib/api/schemas.ts';
import {
	describeRefusal,
	gateRequest,
	refusalStatus,
	type GateSettings,
	type Refusal
} from '#lib/core/daemon/request-gate.ts';
import type { AppHandler } from './app-handler.ts';

/** Headers on every answer: an entry code never leaves in a Referer, and no other site may frame or read the pages. */
const ALWAYS = {
	'referrer-policy': 'no-referrer',
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	'cross-origin-opener-policy': 'same-origin',
	'cross-origin-resource-policy': 'same-origin'
} as const;

function escapeHtml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/** A whole page, with its own styles, since a refused browser gets none of the app's files. */
export function refusalPage(refusal: Refusal): string {
	const { title, message } = describeRefusal(refusal);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>diff delver: ${escapeHtml(title)}</title>
<style>
body { font-family: system-ui, sans-serif; line-height: 1.5; max-width: 36rem; margin: 0 auto; padding: 3rem 1.5rem; }
code { font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p>In a terminal, in your repository: <code>diff-delver</code></p>
</main>
</body>
</html>
`;
}

function header(req: IncomingMessage, name: string): string | undefined {
	const value = req.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function refuse(req: IncomingMessage, res: ServerResponse, refusal: Refusal): void {
	const status = refusalStatus(refusal);
	const api = (req.url ?? '').startsWith('/api/');
	if (api) {
		const { message } = describeRefusal(refusal);
		const body: ApiErrorBody = { error: { kind: 'Refused', message } };
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(JSON.stringify(body));
		return;
	}
	res.writeHead(status, {
		'content-type': 'text/html; charset=utf-8',
		'cache-control': 'no-store'
	});
	res.end(refusalPage(refusal));
}

export function daemonServer(app: AppHandler, settings: () => GateSettings | undefined): Server {
	return createServer((req, res) => {
		for (const [name, value] of Object.entries(ALWAYS)) res.setHeader(name, value);
		const gate = settings();
		if (gate === undefined) {
			res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
			res.end('diff delver is starting. Reload in a moment.\n');
			return;
		}
		const decision = gateRequest(
			{
				method: req.method ?? 'GET',
				target: req.url ?? '/',
				host: header(req, 'host'),
				origin: header(req, 'origin'),
				cookie: header(req, 'cookie'),
				authorization: header(req, 'authorization')
			},
			gate
		);
		switch (decision.kind) {
			case 'serve':
				app(req, res, () => {
					res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
					res.end('Not found\n');
				});
				return;
			case 'enter':
				res.writeHead(303, {
					location: decision.location,
					...(decision.setCookie === undefined ? {} : { 'set-cookie': decision.setCookie }),
					'cache-control': 'no-store'
				});
				res.end();
				return;
			case 'refuse':
				refuse(req, res, decision.refusal);
				return;
		}
	});
}
