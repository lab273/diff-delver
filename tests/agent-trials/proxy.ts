/**
 * The trials' recording proxy: a stdio MCP server to the agent, which starts the
 * real one (`diff-delver mcp`) and passes every message through unchanged, both
 * ways, writing each to a log as it passes. Not product code: only the trial
 * harness (`run.ts`) starts it.
 *
 *     node proxy.ts --log <file> -- <command> <arguments…>
 *
 * MCP over stdio is one JSON-RPC message per line. Each line of the log is one
 * message, `{ "seq", "from": "agent" | "server", "message" }`, in the order the
 * proxy saw them; a line that is not JSON is logged as `"text"`. Standard error
 * of the server goes to the proxy's, as it would to the agent's.
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const logAt = args.indexOf('--log');
const dashes = args.indexOf('--');
const log = args[logAt + 1];
const [command, ...rest] = args.slice(dashes + 1);
if (logAt < 0 || dashes < 0 || log === undefined || command === undefined) {
	process.stderr.write('usage: node proxy.ts --log <file> -- <command> <arguments…>\n');
	process.exit(2);
}

let seq = 0;
function record(from: 'agent' | 'server', line: string): void {
	seq += 1;
	let entry: Record<string, unknown>;
	try {
		const message: unknown = JSON.parse(line);
		entry = { seq, from, message };
	} catch {
		entry = { seq, from, text: line };
	}
	appendFileSync(log ?? '', `${JSON.stringify(entry)}\n`);
}

const child = spawn(command, rest, { stdio: ['pipe', 'pipe', 'inherit'] });

createInterface({ input: process.stdin }).on('line', (line) => {
	record('agent', line);
	child.stdin.write(`${line}\n`);
});
process.stdin.on('end', () => {
	child.stdin.end();
});

createInterface({ input: child.stdout }).on('line', (line) => {
	record('server', line);
	process.stdout.write(`${line}\n`);
});

child.on('exit', (code, signal) => {
	process.exit(code ?? (signal === null ? 0 : 1));
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		child.kill(signal);
	});
}
