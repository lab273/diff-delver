import { err, ok, type Result } from './result.ts';

/** Which tree a line belongs to: `old` is the base, `new` is the head. */
export type Side = 'old' | 'new';

export interface InvalidSide {
	readonly kind: 'InvalidSide';
	readonly value: string;
}

export function parseSide(value: string): Result<Side, InvalidSide> {
	return value === 'old' || value === 'new' ? ok(value) : err({ kind: 'InvalidSide', value });
}

/** The sign that labels a line of this side in a diff: `-` for old, `+` for new. */
export function sideSign(side: Side): '-' | '+' {
	switch (side) {
		case 'old':
			return '-';
		case 'new':
			return '+';
	}
}
