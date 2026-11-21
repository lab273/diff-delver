/**
 * The diff page's keyboard shortcuts (DESIGN 1.1 commitments 5 and 10, 8.3).
 * Each is a faster way to a control the page also shows, and each key is one
 * people know from other tools where one exists: `j` and `k` (and `]` and `[`)
 * to the next and previous file, as in GitLab and Gmail; `r` to mark reviewed,
 * as in Gerrit; `o` to open or close, as in Gmail; `?` for this list, as on
 * GitHub. They never fire while the person types in a field, nor with Control,
 * Alt or Meta held, so the browser's and the system's own keys still work.
 */

export type KeyAction =
	| 'next-part'
	| 'previous-part'
	| 'next-unread'
	| 'toggle-reviewed'
	| 'toggle-open'
	| 'whole-file'
	| 'only-unreviewed'
	| 'side-by-side'
	| 'help';

/** Each shortcut, as the help lists it. */
export const SHORTCUTS: readonly {
	readonly keys: readonly string[];
	readonly does: string;
	readonly action: KeyAction;
}[] = [
	{ keys: ['n'], does: 'Go to the next file you have not reviewed', action: 'next-unread' },
	{ keys: ['j', ']'], does: 'Go to the next file', action: 'next-part' },
	{ keys: ['k', '['], does: 'Go to the previous file', action: 'previous-part' },
	{ keys: ['r'], does: 'Mark the file you are on as reviewed, or not', action: 'toggle-reviewed' },
	{ keys: ['o'], does: 'Show or hide the changes of the file you are on', action: 'toggle-open' },
	{
		keys: ['e'],
		does: 'Show the whole file you are on, or only its changes',
		action: 'whole-file'
	},
	{
		keys: ['u'],
		does: 'Show only what you have not reviewed, or everything',
		action: 'only-unreviewed'
	},
	{
		keys: ['s'],
		does: 'Show changes side by side, or in one column',
		action: 'side-by-side'
	},
	{ keys: ['?'], does: 'Show these shortcuts', action: 'help' }
];

const BY_KEY: ReadonlyMap<string, KeyAction> = new Map(
	SHORTCUTS.flatMap((s) => s.keys.map((key) => [key, s.action] as const))
);

/** What a key press is, as far as the shortcuts care. */
export interface KeyPress {
	readonly key: string;
	readonly ctrlKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	/** The element it was pressed in: what has focus. */
	readonly target: {
		readonly tagName: string;
		readonly type?: string;
		readonly isContentEditable?: boolean;
	} | null;
}

/** Inputs that take no typing, where a letter key means nothing to the control. */
const NOT_TYPED = new Set(['checkbox', 'radio', 'button', 'submit', 'reset']);

/** Whether the press was made while typing in a field. */
function inField(target: KeyPress['target']): boolean {
	if (target === null) return false;
	if (target.isContentEditable === true) return true;
	switch (target.tagName.toLowerCase()) {
		case 'textarea':
		case 'select':
			return true;
		case 'input':
			return !NOT_TYPED.has((target.type ?? 'text').toLowerCase());
		default:
			return false;
	}
}

/** The shortcut a key press asks for, or undefined when it is not one here. */
export function shortcutOf(press: KeyPress): KeyAction | undefined {
	if (press.ctrlKey || press.altKey || press.metaKey) return undefined;
	if (inField(press.target)) return undefined;
	return BY_KEY.get(press.key);
}
