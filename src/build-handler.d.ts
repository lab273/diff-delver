/**
 * The app as the production build makes it (`build/handler.js`, from the Node
 * adapter): a request handler, which the daemon puts behind its own checks. It
 * is imported as `#build/handler.js`, whose "types" condition in package.json
 * points here, so type checking never reads the build; only
 * `src/lib/server/daemon/app-handler.ts` imports it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export declare const handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
