/**
 * Which requests the daemon serves (DESIGN 9). The daemon listens on 127.0.0.1,
 * where every program on the machine and every web page in its browser can reach
 * it, so it serves a request only when:
 *
 * - its `Host` names the daemon itself (`127.0.0.1:<port>` or `localhost:<port>`),
 *   so a web page whose name was pointed at 127.0.0.1 cannot read the answers;
 * - it carries the daemon's token: in the cookie the browser was given, or, from
 *   the command and other programs, as `Authorization: Bearer <token>`;
 * - when it changes anything and the token came in the cookie, its `Origin` is
 *   the daemon's own, so no other page can make the browser act. A browser sends
 *   `Origin` with every such request; a program that sends the token itself
 *   cannot be made to by a page, so it need not.
 *
 * The browser is given the token once, in the address the command opens
 * (`?token=…`). That request is answered with a redirect to the same address
 * without it, setting a cookie for this daemon alone, so the token neither stays
 * in the address bar or the history nor leaks in a `Referer`. The redirect only
 * ever goes to a path of this daemon (`localPath`), whatever the request said.
 *
 * Accepted: browsers send a host's cookies to every port of that host, so
 * another server on 127.0.0.1 that the person's browser visits would receive
 * this daemon's cookie. For a tool one person runs on their own machine, that
 * is accepted rather than guarded against.
 */
import { isToken, type DaemonToken } from '../daemon-token.tiny.ts';
import type { PortNumber } from '../port-number.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';

/** The parts of a request the gate looks at, as they came. */
export interface GateRequest {
	readonly method: string;
	/** The path and query, as in the request line: `/diffs/r_1?token=…`. */
	readonly target: string;
	readonly host: string | undefined;
	readonly origin: string | undefined;
	readonly cookie: string | undefined;
	readonly authorization: string | undefined;
}

export interface GateSettings {
	readonly port: PortNumber;
	readonly token: DaemonToken;
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
	| 'wrong-token';

export type GateDecision =
	/** Serve it. */
	| { readonly kind: 'serve' }
	/** The browser brought the token in the address: set the cookie and send it to `location`. */
	| { readonly kind: 'enter'; readonly location: string; readonly setCookie: string }
	| { readonly kind: 'refuse'; readonly refusal: Refusal };

/** The query parameter the command puts the token in. */
export const TOKEN_PARAMETER = 'token';

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

/** The path and query of `target` with the token parameter taken out. */
function withoutToken(target: string): { readonly location: string; readonly token: string } {
	const queryAt = target.indexOf('?');
	if (queryAt === -1) return { location: target, token: '' };
	const path = target.slice(0, queryAt);
	const kept: string[] = [];
	let token = '';
	for (const pair of target.slice(queryAt + 1).split('&')) {
		const name = pair.split('=', 1)[0] ?? '';
		if (name === TOKEN_PARAMETER) token = pair.slice(name.length + 1);
		else if (pair !== '') kept.push(pair);
	}
	return { location: kept.length === 0 ? path : `${path}?${kept.join('&')}`, token };
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

/** Whether `target` carries the token parameter at all. */
function hasTokenParameter(target: string): boolean {
	const queryAt = target.indexOf('?');
	if (queryAt === -1) return false;
	return target
		.slice(queryAt + 1)
		.split('&')
		.some((pair) => (pair.split('=', 1)[0] ?? '') === TOKEN_PARAMETER);
}

/** What the daemon does with a request. */
export function gateRequest(request: GateRequest, settings: GateSettings): GateDecision {
	const host = request.host?.toLowerCase();
	if (host === undefined || !hostsOf(settings.port).includes(host)) {
		return { kind: 'refuse', refusal: 'wrong-host' };
	}
	const reading = READING.has(request.method.toUpperCase());

	if (reading && hasTokenParameter(request.target)) {
		const { location, token } = withoutToken(request.target);
		if (!isToken(settings.token, token)) return { kind: 'refuse', refusal: 'wrong-token' };
		return {
			kind: 'enter',
			location: localPath(location),
			setCookie: `${tokenCookieName(settings.port)}=${settings.token}; Path=/; HttpOnly; SameSite=Strict`
		};
	}

	const bearer = /^Bearer (.+)$/.exec(request.authorization ?? '')?.[1];
	if (bearer !== undefined) {
		if (!isToken(settings.token, bearer)) return { kind: 'refuse', refusal: 'wrong-token' };
		// A program sending the token itself is not acting for a page; a page cannot
		// send this header to another origin without the token, which it lacks.
		if (!reading && request.origin !== undefined && request.origin !== `http://${host}`) {
			return { kind: 'refuse', refusal: 'wrong-origin' };
		}
		return { kind: 'serve' };
	}

	const cookie = cookieValue(request.cookie, tokenCookieName(settings.port));
	if (cookie === undefined) return { kind: 'refuse', refusal: 'no-token' };
	if (!isToken(settings.token, cookie)) return { kind: 'refuse', refusal: 'wrong-token' };
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
					'This link is from an earlier run of diff delver, which has stopped since. Run diff-delver in a terminal, in your repository, to open it again with a new link.'
				)
			};
	}
}
