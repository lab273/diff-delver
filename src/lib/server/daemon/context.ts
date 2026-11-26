/**
 * What the app's routes need from the daemon that serves them, and where they
 * find it. The daemon (`daemon.ts`) is part of the command's build and the
 * routes are part of the app's (`build/handler.js`), so the daemon registers its
 * context under its port in a global the two share, and `hooks.server.ts` looks
 * it up for each request by the port the request came in on.
 */
import type { AgentServerSetup } from '#lib/core/agent-setup/agent-server.ts';
import type { BuildIdentity } from '#lib/core/build-identity.ts';
import type { Clock } from '#lib/core/clock.ts';
import type { AgentActivity } from '#lib/core/daemon/agent-activity.ts';
import type { StopReason } from '#lib/core/daemon/stop-reason.ts';
import type { ReviewWindowOutcome } from '#lib/core/daemon/review-windows.ts';
import type { CodeVersion } from '#lib/core/code-version.tiny.ts';
import type { EntryCode } from '#lib/core/entry-code.tiny.ts';
import type { PortNumber } from '#lib/core/port-number.tiny.ts';
import type { ReportService } from '../reports/index.ts';
import type { DaemonLog } from './daemon-log.ts';

export interface DaemonContext {
	readonly service: ReportService;
	readonly clock: Clock;
	/** Where the daemon writes what it has to say, each line with its time (`daemon-log.ts`). */
	readonly log: DaemonLog;
	readonly version: CodeVersion;
	/** Which build this is, for the header of every page (`core/build-identity.ts`). */
	readonly build: BuildIdentity;
	/** How an agent is given this daemon as its MCP server: this copy, on this data folder. */
	readonly agentSetup: AgentServerSetup;
	/** The agents this daemon has heard from, which it remembers only while it runs. */
	readonly agents: AgentActivity;
	readonly isCommand: (authorization: string | undefined) => boolean;
	readonly isReviewBrowser: (cookieHeader: string | undefined) => boolean;
	/** A new single-use code that lets a browser in, for the address the command opens. */
	readonly entryCode: () => EntryCode;
	/**
	 * Opens a page of the daemon in the person's own browser, in a window that
	 * may write their drafts; what became of asking. The caller gives the page
	 * and never sees the address (`openForReview` in `daemon.ts`).
	 */
	readonly openForReview: (page: string) => Promise<ReviewWindowOutcome>;
	/** Asks the daemon to stop once the current response is sent, saying why in its log. */
	readonly requestStop: (reason: StopReason) => void;
}

function registry(): Map<number, DaemonContext> {
	globalThis.diffDelverDaemons ??= new Map<number, DaemonContext>();
	return globalThis.diffDelverDaemons;
}

export function registerDaemon(port: PortNumber, context: DaemonContext): void {
	registry().set(port, context);
}

export function unregisterDaemon(port: PortNumber): void {
	registry().delete(port);
}

/** The daemon listening on `port` in this process, if there is one. */
export function daemonOnPort(port: number | undefined): DaemonContext | undefined {
	return port === undefined ? undefined : registry().get(port);
}
