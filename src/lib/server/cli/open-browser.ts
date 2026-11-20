/**
 * Opens an address in the person's browser with the system's own opener, and
 * says whether it could. On Linux without a display, as over ssh, it does not
 * try: the command prints the address instead.
 */
import { spawn } from 'node:child_process';

function opener(url: string): { command: string; args: readonly string[] } | undefined {
	switch (process.platform) {
		case 'darwin':
			return { command: 'open', args: [url] };
		case 'win32':
			// `start` is part of cmd; the empty title keeps it from taking the address as one.
			return { command: 'cmd', args: ['/c', 'start', '""', url.replaceAll('&', '^&')] };
		case 'aix':
		case 'android':
		case 'cygwin':
		case 'freebsd':
		case 'haiku':
		case 'linux':
		case 'netbsd':
		case 'openbsd':
		case 'sunos': {
			const display = process.env['DISPLAY'] ?? process.env['WAYLAND_DISPLAY'];
			return display === undefined || display === ''
				? undefined
				: { command: 'xdg-open', args: [url] };
		}
	}
}

export async function openBrowser(url: string): Promise<boolean> {
	const how = opener(url);
	if (how === undefined) return false;
	return new Promise((resolve) => {
		const child = spawn(how.command, how.args, {
			stdio: 'ignore',
			detached: true,
			windowsHide: true
		});
		child.once('error', () => {
			resolve(false);
		});
		child.once('spawn', () => {
			child.unref();
			resolve(true);
		});
	});
}
