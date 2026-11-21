/**
 * How a person likes the diff drawn (DESIGN 1.1 commitment 9: sensible
 * defaults, few settings, out of the way and remembered). They are the
 * person's on this machine: kept in diff delver's database, in its data
 * folder, so they last across diffs and restarts, and each journey, with a
 * data folder of its own, starts from the defaults.
 */

export interface ViewSettings {
	/** Code coloured by language, or plain. */
	readonly colours: boolean;
}

export const DEFAULT_SETTINGS: ViewSettings = { colours: true };

/** One setting changed: its name and its new value. */
export type SettingChange = { readonly name: 'colours'; readonly value: boolean };

/** The settings with one changed. */
export function withSetting(settings: ViewSettings, change: SettingChange): ViewSettings {
	return { ...settings, colours: change.value };
}
