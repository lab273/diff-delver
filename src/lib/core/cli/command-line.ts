/**
 * The `diff-delver` command line (DESIGN 3), read into what to do. Nothing here
 * asks a question: a command that cannot be read says what was wrong and how to
 * see what the command can do.
 */
import { err, ok, type Result } from '../result.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';
import { parseGitSourceSpec } from '../sources/git-source-spec.ts';
import { describeInvalidSource, parseSourceSpec, type SourceSpec } from '../sources/source-spec.ts';

export type Command =
	/** No command: open what is most likely to be reviewed in this folder. */
	| { readonly kind: 'start' }
	/** One source, as `parseSourceSpec` reads it: a git source or a pull request's address. */
	| { readonly kind: 'open'; readonly source: SourceSpec }
	/** The choose page: commits or a whole branch of this folder's repository to review. */
	| { readonly kind: 'choose' }
	/** The daemon, in the foreground, until it is stopped. */
	| { readonly kind: 'serve' }
	/** Stops the daemon of the data folder. */
	| { readonly kind: 'stop' }
	/** The stdio MCP shim coding agents launch (DESIGN 3). */
	| { readonly kind: 'mcp' }
	/** Connects the coding agents on this machine to this copy, or with `undo` takes that out (DESIGN 3). */
	| { readonly kind: 'setup'; readonly undo: boolean }
	| { readonly kind: 'help' }
	| { readonly kind: 'version' };

export interface Invocation {
	readonly command: Command;
	/** Print the address instead of opening a browser. */
	readonly noOpen: boolean;
	/** The data folder as given, relative to the folder the command runs in, or undefined for the default. */
	readonly dataDirectory: string | undefined;
}

/** The environment variable that names the data folder, when `--data-directory` is not given. */
export const DATA_DIRECTORY_VARIABLE = 'DIFF_DELVER_DATA_DIRECTORY';

export type CommandLineError =
	| { readonly kind: 'UnknownCommand'; readonly word: string }
	| { readonly kind: 'UnknownOption'; readonly option: string }
	| { readonly kind: 'MissingSource' }
	/** A word after a command that takes none, or one more than `open` takes. */
	| {
			readonly kind: 'ExtraArgument';
			readonly command: (typeof COMMANDS)[number];
			readonly argument: string;
	  }
	| { readonly kind: 'MissingOptionValue'; readonly option: string }
	/** `--undo` with a command other than setup. */
	| { readonly kind: 'UndoWithoutSetup' }
	| {
			readonly kind: 'InvalidSource';
			readonly message: ReviewerMessage;
	  };

const COMMANDS = ['open', 'choose', 'serve', 'stop', 'mcp', 'setup', 'help', 'version'] as const;

/** Reads the arguments after the program's name. */
export function parseCommandLine(args: readonly string[]): Result<Invocation, CommandLineError> {
	let noOpen = false;
	let dataDirectory: string | undefined;
	let help = false;
	let version = false;
	let undo = false;
	const words: string[] = [];
	let onlyWords = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] ?? '';
		if (onlyWords || !arg.startsWith('-') || arg === '-') {
			words.push(arg);
			continue;
		}
		if (arg === '--') {
			onlyWords = true;
			continue;
		}
		if (arg === '--no-open') {
			noOpen = true;
		} else if (arg === '--help' || arg === '-h') {
			help = true;
		} else if (arg === '--version' || arg === '-v') {
			version = true;
		} else if (arg === '--undo') {
			undo = true;
		} else if (arg === '--data-directory') {
			const next = args[i + 1];
			if (next === undefined || next === '') {
				return err({ kind: 'MissingOptionValue', option: arg });
			}
			dataDirectory = next;
			i += 1;
		} else if (arg.startsWith('--data-directory=')) {
			const given = arg.slice('--data-directory='.length);
			if (given === '') return err({ kind: 'MissingOptionValue', option: '--data-directory' });
			dataDirectory = given;
		} else if (words[0] === 'open' && words.length === 1 && parseGitSourceSpec(arg).ok) {
			// `diff-delver open --staged`: a source that looks like an option.
			words.push(arg);
		} else {
			return err({ kind: 'UnknownOption', option: arg });
		}
	}
	const done = (command: Command): Result<Invocation, CommandLineError> =>
		ok({ command, noOpen, dataDirectory });
	if (help) return done({ kind: 'help' });
	if (version) return done({ kind: 'version' });

	const [first, ...rest] = words;
	if (first === undefined) return done({ kind: 'start' });
	const known = COMMANDS.find((name) => name === first);
	if (known === undefined) return err({ kind: 'UnknownCommand', word: first });
	if (undo && known !== 'setup') return err({ kind: 'UndoWithoutSetup' });
	switch (known) {
		case 'open': {
			const [source, ...extra] = rest;
			if (source === undefined) return err({ kind: 'MissingSource' });
			if (extra[0] !== undefined) {
				return err({ kind: 'ExtraArgument', command: known, argument: extra[0] });
			}
			const spec = parseSourceSpec(source);
			if (!spec.ok) {
				return err({ kind: 'InvalidSource', message: describeInvalidSource(spec.error) });
			}
			return done({ kind: 'open', source: spec.value });
		}
		case 'setup':
			if (rest[0] !== undefined) {
				return err({ kind: 'ExtraArgument', command: known, argument: rest[0] });
			}
			return done({ kind: 'setup', undo });
		case 'choose':
		case 'serve':
		case 'stop':
		case 'mcp':
		case 'help':
		case 'version': {
			if (rest[0] !== undefined) {
				return err({ kind: 'ExtraArgument', command: known, argument: rest[0] });
			}
			return done({ kind: known });
		}
	}
}

const SEE_HELP = 'Run diff-delver --help to see what it can do.';

/** What a word too many after a command means, said of that command. */
function describeExtraArgument(command: (typeof COMMANDS)[number], argument: string): string {
	switch (command) {
		case 'open':
			return `diff delver did not expect "${argument}" there. To open a range, write it as one word, such as main...feature-x. ${SEE_HELP}`;
		case 'choose':
			return `diff-delver choose did not expect "${argument}" after it: it takes nothing. It shows the branches and commits of the repository whose folder you run it in, so change to that folder first. To open a commit or a range directly, use diff-delver open.`;
		case 'serve':
		case 'stop':
		case 'mcp':
		case 'setup':
		case 'help':
		case 'version':
			return `diff-delver ${command} did not expect "${argument}" after it: it takes nothing. ${SEE_HELP}`;
	}
}

/** What was wrong with the command line, and what to do next. */
export function describeCommandLineError(error: CommandLineError): ReviewerMessage {
	switch (error.kind) {
		case 'UnknownCommand':
			return reviewerMessage(
				`diff delver has no command "${error.word}". To review a commit or a range, run diff-delver open ${error.word}. ${SEE_HELP}`
			);
		case 'UnknownOption':
			return reviewerMessage(`diff delver has no option ${error.option}. ${SEE_HELP}`);
		case 'MissingSource':
			return reviewerMessage(
				'diff-delver open needs what to open: a commit (such as HEAD), two branches to compare (such as main...feature-x), staged, working-tree, or a pull request’s address on GitHub.'
			);
		case 'ExtraArgument':
			return reviewerMessage(describeExtraArgument(error.command, error.argument));
		case 'MissingOptionValue':
			return reviewerMessage(
				`${error.option} needs a folder after it, such as ${error.option} ~/diff-delver-data.`
			);
		case 'UndoWithoutSetup':
			return reviewerMessage(
				`--undo goes with diff-delver setup: diff-delver setup --undo takes out what setup put in. ${SEE_HELP}`
			);
		case 'InvalidSource':
			return error.message;
	}
}

/** What `diff-delver --help` prints. */
export const HELP_TEXT = `diff delver: review a diff, sorted into sections by an agent or by hand.

Usage:
  diff-delver                 Open the changes in this repository that are most
                              likely to be reviewed, in your browser.
  diff-delver open <source>   Open a Delve for working-tree (uncommitted changes),
                              staged, a commit such as HEAD or abc1234, two
                              branches to compare, such as main...feature-x, or
                              a pull request on GitHub by its address, run in a
                              clone of its repository.
  diff-delver choose          Choose commits, or a whole branch, to review: shows
                              this repository's branches and commits, with their
                              sizes and when they were made, in your browser.
  diff-delver serve           Run diff delver in this terminal until Ctrl+C.
  diff-delver stop            Stop diff delver if it is running.
  diff-delver setup           Connect the coding agents on this machine, Claude
                              Code and Codex, to diff delver: adds its MCP
                              server and its skill to each one it finds, and
                              says what it did. Run it once. With --undo, takes
                              out what it put in.
  diff-delver mcp             For coding agents: an MCP server on standard input
                              and output, which lets an agent sort the diff into
                              sections for you. diff-delver setup adds it to your
                              agents; for another agent, add an MCP server that
                              runs this command. It starts diff delver if needed
                              and opens each Delve the agent makes in your
                              browser, unless given --no-open.

Options:
  --no-open                   Print the address instead of opening a browser.
                              The address works once.
  --data-directory <folder>   Keep diff delver's data in this folder. The
                              ${DATA_DIRECTORY_VARIABLE} environment variable does
                              the same.
  --help, -h                  Show this help.
  --version, -v               Show which version this is.

diff delver never writes to the repository you review.`;
