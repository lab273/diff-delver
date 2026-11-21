/**
 * What the app's routes need from the daemon that serves them, and where they
 * find it. The daemon (`daemon.ts`) is part of the command's build and the
 * routes are part of the app's (`build/handler.js`), so the daemon registers its
 * context under its port in a global the two share, and `hooks.server.ts` looks
 * it up for each request by the port the request came in on.
 */
import type { Clock } from '#lib/core/clock.ts';
import type { CodeVersion } from '#lib/core/code-version.tiny.ts';
import type { EntryCode } from '#lib/core/entry-code.tiny.ts';
import type { PortNumber } from '#lib/core/port-number.tiny.ts';
import type { ReportService } from '../reports/index.ts';

export interface DaemonContext {
	readonly service: ReportService;
	readonly clock: Clock;
	readonly version: CodeVersion;
	readonly isBrowserSession: (cookieHeader: string | undefined) => boolean;
	/** A new single-use code that lets a browser in, for the address the command opens. */
	readonly entryCode: () => EntryCode;
	/** Asks the daemon to stop once the current response is sent. */
	readonly requestStop: () => void;
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
