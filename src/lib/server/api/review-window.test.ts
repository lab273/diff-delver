/**
 * Asking diff delver for a window that may write the person's drafts (POST
 * /api/review-window), against a real daemon: who may ask, what the asker
 * gets back, and who gets the grant.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { tokenCookieName, viewCookieName } from '#lib/core/daemon/request-gate.ts';
import {
	browserCookie,
	rawRequest,
	testDaemon,
	type RawResponse
} from '../../../../tests/support/daemons.ts';
import { defineFixture, useFixture } from '../../../../tests/support/fixture-repos.ts';
import { mcpOverHttp, reportIn } from '../../../../tests/support/mcp-client.ts';
import { buildShop } from '../../../../tests/support/scripted-categorisation.ts';
import type { RunningDaemon } from '../daemon/daemon.ts';

const shop = defineFixture('review-window-shop', buildShop);

/** A daemon that records the windows it is asked to open, or cannot open any. */
async function daemonWithWindows(canOpen = true): Promise<{
	readonly daemon: RunningDaemon;
	readonly opened: string[];
}> {
	const opened: string[] = [];
	const daemon = await testDaemon({
		openBrowser: (address) => {
			if (canOpen) opened.push(address);
			return Promise.resolve(canOpen);
		}
	});
	return { daemon, opened };
}

/** An agent's report, and the cookie of a browser that followed the link the agent was given. */
async function followAgentLink(
	daemon: RunningDaemon
): Promise<{ readonly report: string; readonly view: string }> {
	const repo = await useFixture(shop);
	const session = await mcpOverHttp({
		origin: daemon.origin,
		token: daemon.mcpToken,
		directory: repo.dir
	});
	onTestFinished(() => session.close());
	const created = await session.call('create_report', {});
	const link = new URL(/in their browser: (http:\S+)/.exec(created.text)?.[1] ?? '');
	const entered = await rawRequest(daemon.port, { path: link.pathname + link.search });
	const view = entered.headers['set-cookie']?.[0]?.split(';', 1)[0] ?? '';
	expect(view.split('=', 1)[0]).toBe(viewCookieName(daemon.port));
	return { report: reportIn(created), view };
}

function ask(
	daemon: RunningDaemon,
	headers: Readonly<Record<string, string>>,
	diff: string | null
): Promise<RawResponse> {
	return rawRequest(daemon.port, {
		method: 'POST',
		path: '/api/review-window',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ diff })
	});
}

describe('asking for a window that may write drafts', () => {
	it('opens the Delve in the person’s browser, and tells the page only that it did', async () => {
		const { daemon, opened } = await daemonWithWindows();
		const { report, view } = await followAgentLink(daemon);
		const comments = `/api/diffs/${report}/comments`;
		expect(
			(await rawRequest(daemon.port, { path: comments, headers: { cookie: view } })).status
		).toBe(403);

		const answer = await ask(daemon, { cookie: view, origin: daemon.origin }, report);
		expect(answer.status).toBe(200);
		expect(JSON.parse(answer.body)).toEqual({ opened: true });
		expect(opened).toHaveLength(1);
		const window = new URL(opened[0] ?? '');
		expect(window.origin).toBe(daemon.origin);
		expect(window.pathname).toBe(`/diffs/${report}`);
		const code = window.searchParams.get('entry') ?? '';
		expect(code).toMatch(/^[0-9a-f]{32}$/);
		// The asker is given neither the code nor a cookie: the grant goes to the browser alone.
		expect(answer.body).not.toContain(code);
		expect(JSON.stringify(answer.headers)).not.toContain(code);
		expect(answer.headers['set-cookie']).toBeUndefined();
		expect(
			(await rawRequest(daemon.port, { path: comments, headers: { cookie: view } })).status
		).toBe(403);

		// The browser that opens the window may write, and its other tabs with it.
		const entered = await rawRequest(daemon.port, {
			path: window.pathname + window.search,
			headers: { cookie: view }
		});
		expect(entered.status).toBe(303);
		const review = entered.headers['set-cookie']?.[0]?.split(';', 1)[0] ?? '';
		expect(review.split('=', 1)[0]).toBe(tokenCookieName(daemon.port));
		expect(
			(await rawRequest(daemon.port, { path: comments, headers: { cookie: `${view}; ${review}` } }))
				.status
		).toBe(200);
		// The window's address works once.
		expect((await rawRequest(daemon.port, { path: window.pathname + window.search })).status).toBe(
			403
		);

		// With no Delve named, it opens the list of them.
		expect((await ask(daemon, { cookie: view, origin: daemon.origin }, null)).status).toBe(200);
		expect(new URL(opened[1] ?? '').pathname).toBe('/');
	});

	it('is refused from another page, with no cookie, and to every program', async () => {
		const { daemon, opened } = await daemonWithWindows();
		const { report, view } = await followAgentLink(daemon);
		const refused: readonly Readonly<Record<string, string>>[] = [
			// Another page in the person's browser, or a request that says nothing of where it is from.
			{ cookie: view, origin: 'http://evil.example' },
			{ cookie: view, origin: `http://localhost:${String(daemon.port)}` },
			{ cookie: view },
			// No cookie, and a cookie that is not this daemon's.
			{ origin: daemon.origin },
			{ cookie: `${viewCookieName(daemon.port)}=${'0'.repeat(64)}`, origin: daemon.origin },
			// An agent's own credential is good for MCP alone.
			{ authorization: `Bearer ${daemon.mcpToken}` },
			{ authorization: `Bearer ${daemon.mcpToken}`, cookie: view, origin: daemon.origin },
			// The command is not a browser, and has its own way in.
			{ authorization: `Bearer ${daemon.token}` }
		];
		for (const headers of refused) {
			const answer = await ask(daemon, headers, report);
			expect(answer.status, JSON.stringify(Object.keys(headers))).toBe(403);
			expect(answer.headers['set-cookie']).toBeUndefined();
		}
		// MCP's own address serves nothing but MCP, whatever the cookie.
		const overMcp = await rawRequest(daemon.port, {
			method: 'POST',
			path: '/mcp',
			headers: { cookie: view, origin: daemon.origin, 'content-type': 'application/json' },
			body: JSON.stringify({ diff: report })
		});
		expect(overMcp.status).toBe(403);
		expect(opened).toEqual([]);

		// A browser that may write already may ask too; nothing is refused it.
		const review = await browserCookie(daemon);
		expect((await ask(daemon, { cookie: review, origin: daemon.origin }, report)).status).toBe(200);
		expect(opened).toHaveLength(1);
		// What it sends must name a Delve or none.
		expect((await ask(daemon, { cookie: review, origin: daemon.origin }, '../x')).status).toBe(400);
		expect(opened).toHaveLength(1);
	});

	it('says so when no browser can be opened, and gives nothing else', async () => {
		const { daemon } = await daemonWithWindows(false);
		const { report, view } = await followAgentLink(daemon);
		const answer = await ask(daemon, { cookie: view, origin: daemon.origin }, report);
		expect(answer.status).toBe(200);
		expect(JSON.parse(answer.body)).toEqual({ opened: false });
	});
});
