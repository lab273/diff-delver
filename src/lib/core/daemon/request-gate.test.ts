import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { settableClock } from '../clock.ts';
import { isToken, parseDaemonToken, type DaemonToken } from '../daemon-token.tiny.ts';
import { parseEntryCode } from '../entry-code.tiny.ts';
import { parseTimestamp } from '../timestamp.tiny.ts';
import { entryCodes } from './entry-codes.ts';
import { parsePortNumber, type PortNumber } from '../port-number.tiny.ts';
import {
	cookieValue,
	describeRefusal,
	gateRequest,
	tokenCookieName,
	type GateRequest,
	type GateSettings,
	type Refusal
} from './request-gate.ts';

function made<T>(result: { ok: true; value: T } | { ok: false }): T {
	if (!result.ok) throw new Error('did not parse');
	return result.value;
}

const token: DaemonToken = made(parseDaemonToken('ab'.repeat(32)));
const other: DaemonToken = made(parseDaemonToken('cd'.repeat(32)));
const port: PortNumber = made(parsePortNumber(43210));
const code = 'c'.repeat(32);
/** The gate as a daemon that has given out `code` and will take any number of times. */
const settings: GateSettings = { port, token, redeemEntryCode: (given) => given === code };
const host = '127.0.0.1:43210';
const cookie = `${tokenCookieName(port)}=${token}`;

function request(overrides: Partial<GateRequest>): GateRequest {
	return {
		method: 'GET',
		target: '/',
		host,
		origin: undefined,
		cookie: undefined,
		authorization: undefined,
		...overrides
	};
}

describe('the daemon token', () => {
	it('is 64 lowercase hex digits', () => {
		expect(parseDaemonToken('ab'.repeat(32)).ok).toBe(true);
		expect(parseDaemonToken('AB'.repeat(32)).ok).toBe(false);
		expect(parseDaemonToken('ab'.repeat(31)).ok).toBe(false);
		expect(parseDaemonToken('').ok).toBe(false);
	});

	it('matches only itself, whatever is given', () => {
		fc.assert(
			fc.property(fc.string(), (given) => {
				expect(isToken(token, given)).toBe(given === token);
			})
		);
		expect(isToken(token, token)).toBe(true);
		expect(isToken(token, `${token}x`)).toBe(false);
		expect(isToken(token, token.slice(0, -1))).toBe(false);
	});
});

describe('the request gate', () => {
	it('lets the browser in with an entry code in the address, and takes it out of the address', () => {
		expect(gateRequest(request({ target: `/diffs/r_1?entry=${code}` }), settings)).toEqual({
			kind: 'enter',
			location: '/diffs/r_1',
			setCookie: `diff-delver-43210=${token}; Path=/; HttpOnly; SameSite=Strict`
		});
		expect(gateRequest(request({ target: `/?entry=${code}` }), settings)).toMatchObject({
			kind: 'enter',
			location: '/'
		});
		expect(
			gateRequest(request({ target: `/start?directory=%2Frepo&entry=${code}&x=1` }), settings)
		).toMatchObject({ kind: 'enter', location: '/start?directory=%2Frepo&x=1' });
	});

	it('takes an entry code once, and never the token in the address', () => {
		const time = parseTimestamp(1000);
		const codes = entryCodes(settableClock(made(time)));
		const issued = made(parseEntryCode('d'.repeat(32)));
		codes.issue(issued);
		const once: GateSettings = { port, token, redeemEntryCode: (given) => codes.redeem(given) };
		const target = `/diffs/r_1?entry=${issued}`;
		expect(gateRequest(request({ target }), once)).toMatchObject({ kind: 'enter' });
		expect(gateRequest(request({ target }), once)).toEqual({
			kind: 'refuse',
			refusal: 'entry-used'
		});
		// A browser that was let in already is sent on, as from its history.
		expect(gateRequest(request({ target, cookie }), once)).toEqual({
			kind: 'enter',
			location: '/diffs/r_1',
			setCookie: undefined
		});
		expect(gateRequest(request({ target: `/?token=${token}` }), once)).toEqual({
			kind: 'refuse',
			refusal: 'no-token'
		});
	});

	it('sends the browser only to a path of its own, whatever the address held', () => {
		const at = (target: string): string => {
			const decision = gateRequest(request({ target }), settings);
			if (decision.kind !== 'enter') throw new Error(`not let in: ${target}`);
			return decision.location;
		};
		expect(at(`//evil.example?entry=${code}`)).toBe('/evil.example');
		expect(at(`///evil.example/x?entry=${code}&a=1`)).toBe('/evil.example/x?a=1');
		expect(at(`/\\evil.example?entry=${code}`)).toBe('/');
		expect(at(`/\t/evil.example?entry=${code}`)).toBe('/');
		expect(at(`https://evil.example/?entry=${code}`)).toBe('/');
		expect(at(`?entry=${code}`)).toBe('/');
		fc.assert(
			fc.property(fc.string({ unit: 'binary' }), fc.string(), (path, query) => {
				const location = at(`${path}?${query.replaceAll('&', '')}&entry=${code}`);
				// A browser reads it against the daemon's own address and stays there.
				const resolved = new URL(location, `http://${host}/somewhere/`);
				expect(resolved.origin).toBe(`http://${host}`);
				expect(location).toMatch(/^\/(?![/\\])/);
			})
		);
	});

	it('says a used link, and one with another daemon’s token, is out of date', () => {
		expect(gateRequest(request({ target: `/?entry=${'e'.repeat(32)}` }), settings)).toEqual({
			kind: 'refuse',
			refusal: 'entry-used'
		});
		expect(gateRequest(request({ cookie: `${tokenCookieName(port)}=${other}` }), settings)).toEqual(
			{ kind: 'refuse', refusal: 'wrong-token' }
		);
	});

	it('serves the browser with the cookie, and refuses it without', () => {
		expect(gateRequest(request({ cookie }), settings)).toEqual({ kind: 'serve' });
		expect(gateRequest(request({ cookie: `other=1; ${cookie}; more=2` }), settings)).toEqual({
			kind: 'serve'
		});
		expect(gateRequest(request({}), settings)).toEqual({ kind: 'refuse', refusal: 'no-token' });
		// Another daemon's cookie, on another port of the same host, is not this one's.
		expect(gateRequest(request({ cookie: `diff-delver-1=${token}` }), settings)).toEqual({
			kind: 'refuse',
			refusal: 'no-token'
		});
	});

	it('answers only to its own address', () => {
		for (const wrong of [
			undefined,
			'evil.example',
			'127.0.0.1',
			'127.0.0.1:1',
			'evil.example:43210'
		]) {
			expect(gateRequest(request({ host: wrong, cookie }), settings)).toEqual({
				kind: 'refuse',
				refusal: 'wrong-host'
			});
		}
		expect(gateRequest(request({ host: 'localhost:43210', cookie }), settings)).toEqual({
			kind: 'serve'
		});
		expect(
			gateRequest(request({ host: 'evil.example:43210', target: `/?entry=${code}` }), settings)
		).toEqual({ kind: 'refuse', refusal: 'wrong-host' });
	});

	it('makes a change asked for with the cookie only from its own pages', () => {
		const post = (origin: string | undefined): GateRequest =>
			request({ method: 'POST', target: '/api/start', cookie, origin });
		expect(gateRequest(post(`http://${host}`), settings)).toEqual({ kind: 'serve' });
		expect(gateRequest(post(undefined), settings)).toEqual({
			kind: 'refuse',
			refusal: 'wrong-origin'
		});
		expect(gateRequest(post('http://evil.example'), settings)).toEqual({
			kind: 'refuse',
			refusal: 'wrong-origin'
		});
		expect(gateRequest(post('http://localhost:43210'), settings)).toEqual({
			kind: 'refuse',
			refusal: 'wrong-origin'
		});
		expect(gateRequest({ ...post(`http://${host}`), method: 'DELETE' }, settings)).toEqual({
			kind: 'serve'
		});
		// An entry code in the address lets a browser in only to read.
		expect(
			gateRequest(
				request({ method: 'POST', target: `/api/start?entry=${code}`, origin: `http://${host}` }),
				settings
			)
		).toEqual({ kind: 'refuse', refusal: 'no-token' });
	});

	it('serves a program that sends the token itself, with no Origin', () => {
		const bearer = `Bearer ${token}`;
		expect(
			gateRequest(
				request({ method: 'POST', target: '/api/start', authorization: bearer }),
				settings
			)
		).toEqual({ kind: 'serve' });
		expect(
			gateRequest(
				request({ method: 'POST', authorization: bearer, origin: 'http://evil.example' }),
				settings
			)
		).toEqual({ kind: 'refuse', refusal: 'wrong-origin' });
		expect(gateRequest(request({ authorization: `Bearer ${other}`, cookie }), settings)).toEqual({
			kind: 'refuse',
			refusal: 'wrong-token'
		});
	});

	it('says what to do for every refusal, without internal words', () => {
		const refusals: readonly Refusal[] = [
			'wrong-host',
			'wrong-origin',
			'no-token',
			'wrong-token',
			'entry-used'
		];
		for (const refusal of refusals) {
			const { title, message } = describeRefusal(refusal);
			expect(title).not.toBe('');
			expect(message).toMatch(/diff delver|diff-delver/);
			expect(`${title} ${message}`).not.toMatch(/report|token|cookie|origin/i);
		}
	});

	it('reads one cookie from a Cookie header', () => {
		expect(cookieValue('a=1; b=2', 'b')).toBe('2');
		expect(cookieValue('a=1;b=2', 'a')).toBe('1');
		expect(cookieValue('ab=1', 'a')).toBeUndefined();
		expect(cookieValue(undefined, 'a')).toBeUndefined();
	});
});
