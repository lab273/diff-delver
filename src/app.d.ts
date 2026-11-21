// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { DaemonContext } from '#lib/server/daemon/context.ts';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/** The daemon serving this request: its report service and clock (hooks.server.ts). */
			daemon: DaemonContext;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	/** Which build this is, written in by the command's build (src/lib/server/version.ts). */
	const __DIFF_DELVER_VERSION__: string | undefined;

	/**
	 * The daemons running in this process, by the port each listens on, for the
	 * app's routes to find theirs (src/lib/server/daemon/context.ts). The daemon
	 * and the app are built separately, so a module of one cannot hold the other's
	 * state; this global is where they meet.
	 */
	var diffDelverDaemons: Map<number, DaemonContext> | undefined;

	interface Window {
		/**
		 * Keys pressed before the page's scripts ran, kept by the script in
		 * src/app.html until the page can act on them (src/lib/ui/early-input.ts).
		 */
		diffDelverEarlyInput?: {
			readonly kept: readonly { readonly key: string; readonly shiftKey: boolean }[];
			stop(): void;
		};
	}
}

export {};
