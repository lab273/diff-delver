/**
 * Whether the panel that lists the other Delves is open. The layout draws the
 * panel and the header's button for it; a Delve's page opens it from its own
 * button and key. Made once per page drawn and handed down as context, so no
 * two requests on the server share one.
 */
import { getContext, setContext } from 'svelte';

const KEY = Symbol('delve switcher');

export class DelveSwitcher {
	open = $state(false);
}

/** Makes the layout's switcher and offers it to the pages under it. */
export function provideDelveSwitcher(): DelveSwitcher {
	const switcher = new DelveSwitcher();
	setContext(KEY, switcher);
	return switcher;
}

/** The switcher of the layout this page is drawn in. */
export function delveSwitcher(): DelveSwitcher {
	const switcher: unknown = getContext(KEY);
	if (!(switcher instanceof DelveSwitcher)) {
		throw new Error('The Delve switcher is offered by the layout, which is missing.');
	}
	return switcher;
}
