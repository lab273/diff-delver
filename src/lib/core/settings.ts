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
}

export const DEFAULT_SETTINGS: ViewSettings = {
	colours: true,
	layout: 'unified',
	hideWhiteSpace: false
};

/** One setting changed: its name and its new value. */
export type SettingChange =
	| { readonly name: 'colours'; readonly value: boolean }
	| { readonly name: 'layout'; readonly value: Layout }
	| { readonly name: 'hide-white-space'; readonly value: boolean };

/** The settings with one changed. */
export function withSetting(settings: ViewSettings, change: SettingChange): ViewSettings {
	switch (change.name) {
		case 'colours':
			return { ...settings, colours: change.value };
		case 'layout':
			return { ...settings, layout: change.value };
		case 'hide-white-space':
			return { ...settings, hideWhiteSpace: change.value };
	}
}
