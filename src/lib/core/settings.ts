/**
 * How a person likes the diff drawn (DESIGN 1.1 commitment 9: sensible
 * defaults, few settings, out of the way and remembered). They are the
 * person's on this machine: kept in diff delver's database, in its data
 * folder, so they last across diffs and restarts, and each journey, with a
 * data folder of its own, starts from the defaults.
 */

/** A part's lines one under another, as one column, or old and new side by side. */
export type Layout = 'unified' | 'side-by-side';

export interface ViewSettings {
	/** Code coloured by language, or plain. */
	readonly colours: boolean;
	readonly layout: Layout;
	/** Changes that only change white space drawn as unchanged lines, or shown as changes. */
	readonly hideWhiteSpace: boolean;
	/** How a search reads: upper and lower case told apart. */
	readonly searchMatchCase: boolean;
	/** A search of the diff reads changed lines only, besides paths. */
	readonly searchChangedOnly: boolean;
	/** A search of the diff passes over files that are closed. */
	readonly searchSkipClosed: boolean;
	/**
	 * The overall review's bar at the foot of a Delve's page open, with its box,
	 * or put away, showing only its first words and the count of comments.
	 */
	readonly overallReviewOpen: boolean;
}

export const DEFAULT_SETTINGS: ViewSettings = {
	colours: true,
	layout: 'unified',
	hideWhiteSpace: false,
	searchMatchCase: false,
	searchChangedOnly: false,
	searchSkipClosed: false,
	// Put away, the bar still says what is written and how many comments there
	// are, and the diff keeps the room an open box would take.
	overallReviewOpen: false
};

/** One setting changed: its name and its new value. */
export type SettingChange =
	| { readonly name: 'colours'; readonly value: boolean }
	| { readonly name: 'layout'; readonly value: Layout }
	| { readonly name: 'hide-white-space'; readonly value: boolean }
	| { readonly name: 'search-match-case'; readonly value: boolean }
	| { readonly name: 'search-changed-only'; readonly value: boolean }
	| { readonly name: 'search-skip-closed'; readonly value: boolean }
	| { readonly name: 'overall-review-open'; readonly value: boolean };

/** The settings with one changed. */
export function withSetting(settings: ViewSettings, change: SettingChange): ViewSettings {
	switch (change.name) {
		case 'colours':
			return { ...settings, colours: change.value };
		case 'layout':
			return { ...settings, layout: change.value };
		case 'hide-white-space':
			return { ...settings, hideWhiteSpace: change.value };
		case 'search-match-case':
			return { ...settings, searchMatchCase: change.value };
		case 'search-changed-only':
			return { ...settings, searchChangedOnly: change.value };
		case 'search-skip-closed':
			return { ...settings, searchSkipClosed: change.value };
		case 'overall-review-open':
			return { ...settings, overallReviewOpen: change.value };
	}
}
