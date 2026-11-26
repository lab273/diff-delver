/**
 * The diff page's keyboard shortcuts (DESIGN 1.1 commitments 5 and 10, 8.3).
 * Each is a faster way to a control the page also shows, and each key is one
 * people know from other tools where one exists: `j` and `k` (and `]` and `[`)
 * to the next and previous file, as in GitLab and Gmail; `r` to mark reviewed
 * and go on to the next file waiting, as in Gerrit; `o` to open or close, as
 * in Gmail; `c` to comment, as in Gerrit and GitLab; `d` to open another
 * Delve; `v`, for review, to write the overall review; `?` for this list, as
 * on GitHub. They never fire while the person types in a field, nor with
 * Control, Alt or Meta held, so the browser's and the system's own keys still
 * work.
 */

export type KeyAction =
	| 'next-part'
	| 'previous-part'
	| 'next-unread'
	| 'mark-reviewed'
	| 'toggle-open'
	| 'comment'
	| 'whole-file'
	| 'only-unreviewed'
	| 'side-by-side'
	| 'white-space'
	| 'compare-images'
	| 'bookmark'
	| 'return-to-bookmark'
	| 'search'
	| 'open-file'
	| 'other-delves'
	| 'overall-review'
	| 'help';

/** Each shortcut, as the help lists it. */
export const SHORTCUTS: readonly {
	readonly keys: readonly string[];
	/** Keys held with Control or Command that do the same, as the list shows them. */
	readonly chords?: readonly string[];
	readonly does: string;
	readonly action: KeyAction;
}[] = [
	{ keys: ['n'], does: 'Go to the next file you have not reviewed', action: 'next-unread' },
	{ keys: ['j', ']'], does: 'Go to the next file', action: 'next-part' },
	{ keys: ['k', '['], does: 'Go to the previous file', action: 'previous-part' },
	{
		keys: ['r'],
		does: 'Mark the file you are on as reviewed and go to the next you have not reviewed. To take the mark off, use the file’s tick box',
		action: 'mark-reviewed'
	},
	{ keys: ['o'], does: 'Show or hide the changes of the file you are on', action: 'toggle-open' },
	{
		keys: ['c'],
		does: 'Comment on the line you are on. From anywhere else, go to the lines of the file you are on: the arrow keys move between lines, and Shift with them takes several',
		action: 'comment'
	},
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
	{
		keys: ['w'],
		does: 'Hide changes that only change white space, or show them',
		action: 'white-space'
	},
	{
		keys: ['i'],
		does: 'Compare changed images another way: side by side, with a slider, in onion skin, or by the pixels that changed',
		action: 'compare-images'
	},
	{
		keys: ['/'],
		chords: ['Ctrl+F'],
		does: 'Search the diff: Enter and Shift+Enter go from match to match, Escape closes it. In the search box, Ctrl+F (Command+F on a Mac) is the browser’s own find',
		action: 'search'
	},
	{ keys: ['t'], does: 'Open a file by name', action: 'open-file' },
	{ keys: ['b'], does: 'Bookmark where you are reading', action: 'bookmark' },
	{ keys: ['B'], does: 'Return to your bookmark', action: 'return-to-bookmark' },
	{
		keys: ['d'],
		does: 'Open another Delve, or something new in this repository',
		action: 'other-delves'
	},
	{
		keys: ['v'],
		does: 'Write your overall review of the change, at the foot of the page, or put it away',
		action: 'overall-review'
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
const NOT_TYPED = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range']);

/** Whether the press was made while typing in a field. */
export function inField(target: KeyPress['target']): boolean {
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

/**
 * Whether a press is the browser's "find in page" (Control+F, or Command+F on
 * a Mac), which opens the diff's search: it finds text in every file of the
 * diff, not only those drawn. Pressed again in the search box it is left to
 * the browser, so its own find is one more press away.
 */
export function isFindKey(
	press: Pick<KeyPress, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'>,
	inSearchBox: boolean
): boolean {
	if (inSearchBox || press.altKey || !(press.ctrlKey || press.metaKey)) return false;
	return press.key === 'f' || press.key === 'F';
}

/** The shortcuts that move from file to file, which a key held down repeats. */
const REPEATED: ReadonlySet<KeyAction> = new Set(['next-part', 'previous-part', 'next-unread']);

/**
 * Whether a shortcut acts again on the presses a key held down repeats. Only
 * moving does: no other shortcut acts on a repeat, so holding `r` marks one
 * file, not a file for each repeat, and holding `o` does not open and close a
 * file over and over. A key that puts the focus in a field, as `/`, `v` and
 * `t` do, may still type its repeats there.
 */
export function actsOnRepeat(action: KeyAction): boolean {
	return REPEATED.has(action);
}

/** The shortcut a key press asks for, or undefined when it is not one here. */
export function shortcutOf(press: KeyPress): KeyAction | undefined {
	if (press.ctrlKey || press.altKey || press.metaKey) return undefined;
	if (inField(press.target)) return undefined;
	return BY_KEY.get(press.key);
}
