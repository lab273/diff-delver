/**
 * Which requests the daemon serves (DESIGN 9). The daemon listens on 127.0.0.1,
 * where every program on the machine and every web page in its browser can reach
 * it, so it serves a request only when:
 *
 * - its `Host` names the daemon itself (`127.0.0.1:<port>` or `localhost:<port>`),
 *   so a web page whose name was pointed at 127.0.0.1 cannot read the answers;
 * - it carries a browser session cookie, the command bearer token for the app,
 *   or the MCP bearer token for `/mcp`;
 * - when it changes anything and the token came in the cookie, its `Origin` is
 *   the daemon's own, so no other page can make the browser act. A browser sends
 *   `Origin` with every such request; a program that sends the token itself
 *   cannot be made to by a page, so it need not.
 *
 * The browser is let in by the address the command opens, which carries a
 * single-use entry code (`?entry=…`, `entry-codes.ts`), never the token itself:
 * a process's arguments, such as the browser opener's, can be read by anyone on
 * the machine. That request is answered with a redirect to the same address
 * without the code, setting the token as a cookie for this daemon alone, so
 * nothing secret stays in the address bar or the history or leaks in a
 * `Referer`. A code works once, for two minutes; a browser that already has the
 * cookie is sent on even with a used code, as when it opens the address again
 * from its history. The redirect only ever goes to a path of this daemon
 * (`localPath`), whatever the request said.
 *
 * MCP (`/mcp`, DESIGN 3) is for programs only: the stdio shim and clients that
 * speak HTTP MCP. It is served only with its separate bearer token, never
 * on the cookie alone, so no page the person's browser visits can reach it,
 * even one the browser would send the cookie with; and like any change asked
 * with the token, a request that comes from a page (`Origin`) must come from
 * the daemon's own.
 *
 * Accepted: browsers send a host's cookies to every port of that host, so
 * another server on 127.0.0.1 that the person's browser visits would receive
 * this daemon's cookie. For a tool one person runs on their own machine, that
 * is accepted rather than guarded against.
 */
import type { BrowserGrant } from './entry-codes.ts';
import { isToken, type DaemonToken } from '../daemon-token.tiny.ts';
import type { PortNumber } from '../port-number.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';

/** The parts of a request the gate looks at, as they came. */
export interface GateRequest {
	readonly method: string;
	/** The path and query, as in the request line: `/diffs/r_1?entry=…`. */
	readonly target: string;
	readonly host: string | undefined;
	readonly origin: string | undefined;
	readonly cookie: string | undefined;
	readonly authorization: string | undefined;
}

export interface GateSettings {
	readonly port: PortNumber;
	readonly token: DaemonToken;
	readonly mcpToken: DaemonToken;
	readonly browserToken: DaemonToken;
	readonly viewToken: DaemonToken;
	/** Whether `given` is an entry code that may be used now; using it means it never works again. */
	readonly redeemEntryCode: (given: string) => BrowserGrant | undefined;
}

/** Why a request is not served. */
export type Refusal =
	/** `Host` is not the daemon's: a web page reaching it under another name. */
	| 'wrong-host'
	/** It would change something, and came from another page or none. */
	| 'wrong-origin'
	/** No token: the address was typed or bookmarked, or the cookie is gone. */
	| 'no-token'
	/** A token that is not this daemon's: a link from an earlier run of diff delver. */
	| 'wrong-token'
	/** An entry code that has been used, has run out, or is from an earlier run. */
	| 'entry-used';

export type GateDecision =
	/** Serve it. */
	| { readonly kind: 'serve' }
	/**
	 * The browser brought an entry code in the address: send it to `location`,
	 * setting the cookie when the code let it in, not when it had the cookie already.
	 */
	| { readonly kind: 'enter'; readonly location: string; readonly setCookie: string | undefined }
	| { readonly kind: 'refuse'; readonly refusal: Refusal };

/** The path MCP is served at. */
export const MCP_PATH = '/mcp';

/** Whether a request's target is the MCP endpoint, with or without a query. */
export function isMcpTarget(target: string): boolean {
	return (target.split('?', 1)[0] ?? '') === MCP_PATH;
}

/** The query parameter the command puts the entry code in. */
export const ENTRY_PARAMETER = 'entry';

/**
 * The cookie the token is kept in. Cookies are shared by every port of a host,
 * so its name carries the port: two daemons, with two data folders, never take
 * each other's.
 */
export function tokenCookieName(port: PortNumber): string {
	return `diff-delver-${String(port)}`;
}

/** The hosts the daemon answers to. */
function hostsOf(port: PortNumber): readonly string[] {
	return [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`];
}

/** The value of one cookie in a `Cookie` header, or undefined. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
	if (header === undefined) return undefined;
	for (const part of header.split(';')) {
		const at = part.indexOf('=');
		if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
	}
	return undefined;
}

/** Methods that only read. Everything else must come from the daemon's own pages. */
const READING = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The path and query of `target` with the entry code taken out. */
function withoutEntryCode(target: string): { readonly location: string; readonly code: string } {
	const queryAt = target.indexOf('?');
	if (queryAt === -1) return { location: target, code: '' };
	const path = target.slice(0, queryAt);
	const kept: string[] = [];
	let code = '';
	for (const pair of target.slice(queryAt + 1).split('&')) {
		const name = pair.split('=', 1)[0] ?? '';
		if (name === ENTRY_PARAMETER) code = pair.slice(name.length + 1);
		else if (pair !== '') kept.push(pair);
	}
	return { location: kept.length === 0 ? path : `${path}?${kept.join('&')}`, code };
}

/**
 * `location` as a path of this daemon, for a redirect: one leading slash, so a
 * browser can never read it as another site (`//evil.example`, `/\evil.example`,
 * `https://…`). Anything that is not a plain path, such as one with a backslash
 * or a control character, which browsers treat as a slash or drop, is home.
 */
export function localPath(location: string): string {
	for (let i = 0; i < location.length; i += 1) {
		const code = location.charCodeAt(i);
		if (code <= 0x20 || code === 0x7f || code === 0x5c) return '/';
	}
	if (!location.startsWith('/')) return '/';
	return `/${location.replace(/^\/+/, '')}`;
}

/** Whether `target` carries an entry code at all. */
function hasEntryCode(target: string): boolean {
	const queryAt = target.indexOf('?');
	if (queryAt === -1) return false;
	return target
		.slice(queryAt + 1)
		.split('&')
		.some((pair) => (pair.split('=', 1)[0] ?? '') === ENTRY_PARAMETER);
}

/** What the daemon does with a request. */
export function gateRequest(request: GateRequest, settings: GateSettings): GateDecision {
	const host = request.host?.toLowerCase();
	if (host === undefined || !hostsOf(settings.port).includes(host)) {
		return { kind: 'refuse', refusal: 'wrong-host' };
	}
	const reading = READING.has(request.method.toUpperCase());

	const cookie = cookieValue(request.cookie, tokenCookieName(settings.port));
	const review = cookie !== undefined && isToken(settings.browserToken, cookie);
	const view = cookie !== undefined && isToken(settings.viewToken, cookie);
	if (reading && hasEntryCode(request.target)) {
		const { location, code } = withoutEntryCode(request.target);
		const grant = settings.redeemEntryCode(code);
		if (grant === 'review' || (grant === 'view' && !review)) {
			const token = grant === 'review' ? settings.browserToken : settings.viewToken;
			return {
				kind: 'enter',
				location: localPath(location),
				setCookie: `${tokenCookieName(settings.port)}=${token}; Path=/; HttpOnly; SameSite=Strict`
			};
		}
		if (review || view) {
			return { kind: 'enter', location: localPath(location), setCookie: undefined };
		}
		return { kind: 'refuse', refusal: 'entry-used' };
	}

	const bearer = /^Bearer (.+)$/.exec(request.authorization ?? '')?.[1];
	if (bearer !== undefined) {
		if (!isToken(isMcpTarget(request.target) ? settings.mcpToken : settings.token, bearer))
			return { kind: 'refuse', refusal: 'wrong-token' };
		// A program sending the token itself is not acting for a page; a page cannot
		// send this header to another origin without the token, which it lacks.
		if (!reading && request.origin !== undefined && request.origin !== `http://${host}`) {
			return { kind: 'refuse', refusal: 'wrong-origin' };
		}
		return { kind: 'serve' };
	}

	// MCP is served only to programs that bring the token themselves.
	if (isMcpTarget(request.target)) return { kind: 'refuse', refusal: 'no-token' };
	if (cookie === undefined) return { kind: 'refuse', refusal: 'no-token' };
	if (!review && !view) return { kind: 'refuse', refusal: 'wrong-token' };
	if (!reading && request.origin !== `http://${host}`) {
		return { kind: 'refuse', refusal: 'wrong-origin' };
	}
	return { kind: 'serve' };
}

/** The status a refusal is answered with. */
export function refusalStatus(refusal: Refusal): 403 | 421 {
	switch (refusal) {
		case 'wrong-host':
			return 421;
		case 'wrong-origin':
		case 'no-token':
		case 'wrong-token':
		case 'entry-used':
			return 403;
	}
}

/** What a refused page says: what happened and what to do next. */
export function describeRefusal(refusal: Refusal): {
	readonly title: ReviewerMessage;
	readonly message: ReviewerMessage;
} {
	switch (refusal) {
		case 'wrong-host':
			return {
				title: reviewerMessage('Open diff delver by its own address'),
				message: reviewerMessage(
					'diff delver answers only at the address it prints, which starts with http://127.0.0.1. Run diff-delver in a terminal, in your repository, and it opens the right page for you.'
				)
			};
		case 'wrong-origin':
			return {
				title: reviewerMessage('This came from another page'),
				message: reviewerMessage(
					'diff delver only makes changes asked for from its own pages, so nothing was changed. Go back to diff delver’s page and try again there.'
				)
			};
		case 'no-token':
			return {
				title: reviewerMessage('Open diff delver from your terminal'),
				message: reviewerMessage(
					'For your safety, diff delver opens only from the link it gives you, so no other page or program can read your code. Run diff-delver in a terminal, in your repository: it opens this page for you. To see the address without opening a browser, run diff-delver --no-open.'
				)
			};
		case 'wrong-token':
			return {
				title: reviewerMessage('This link is out of date'),
				message: reviewerMessage(
					'This link is from an earlier run of diff delver, which has stopped since. Run diff-delver in a terminal, in your repository, to open it again with a new link, or, if a coding agent gave you the link, ask it for a new one.'
				)
			};
		case 'entry-used':
			return {
				title: reviewerMessage('This link is out of date'),
				message: reviewerMessage(
					'Each link diff delver gives you opens it once, within two minutes, and this one has been used already or has run out. Run diff-delver in a terminal, in your repository, to open it again with a new link, or, if a coding agent gave you the link, ask it for a new one.'
				)
			};
	}
}
