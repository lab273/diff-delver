/**
 * The skill as `diff-delver setup` puts it in an agent's skills folder
 * (DESIGN 7.3): the one copy (`plugins/claude-code/skills/diff-delver/SKILL.md`)
 * with a line after its front matter that says who put it there. That line is
 * how setup and its undo know the file is theirs to change or take away: a
 * `SKILL.md` without it, such as one a person saved by hand, is never
 * overwritten or removed, since it may hold their own words.
 */

/** The line that marks a skill file as put there by setup, a Markdown comment the agent may read. */
export const SKILL_MARK =
	'<!-- Put here by diff-delver setup, which keeps it up to date; diff-delver setup --undo takes it away. -->';

/** The skill as setup writes it: the mark after the front matter, which must come first. */
export function installedSkill(skill: string): string {
	const front = /^---\n[\s\S]*?\n---\n/.exec(skill);
	if (front === null) return `${SKILL_MARK}\n\n${skill}`;
	return `${front[0]}\n${SKILL_MARK}\n${skill.slice(front[0].length)}`;
}

/** Whether a skill file was put there by setup. */
export function isSetupSkill(text: string): boolean {
	return text.split('\n').includes(SKILL_MARK);
}

/** What setup does with the skill file it finds, or does not. */
export type SkillChange =
	| 'add'
	/** Setup's, or the same words saved by hand: nothing to do. */
	| 'unchanged'
	/** Setup's, from another version of diff delver. */
	| 'update'
	/** Not setup's, and not the same words: left as it is. */
	| 'theirs';

/** What to do with `existing`, the skill file there now (undefined when there is none). */
export function skillChange(existing: string | undefined, skill: string): SkillChange {
	if (existing === undefined) return 'add';
	const ours = installedSkill(skill);
	if (existing === ours) return 'unchanged';
	if (isSetupSkill(existing)) return 'update';
	return existing === skill ? 'unchanged' : 'theirs';
}
