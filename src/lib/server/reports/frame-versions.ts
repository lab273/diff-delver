import { randomUUID } from 'node:crypto';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import type { Report } from '#lib/core/reports/report.ts';

/** Opaque stamps for one connection. Changes from other connections invalidate them. */
export class FrameVersions {
	readonly #instance = randomUUID();
	readonly #edits = new Map<RevisionId, number>();

	/** Review marks and overview edits, in addition to sorting writes. */
	edited(revision: RevisionId): void {
		this.#edits.set(revision, (this.#edits.get(revision) ?? 0) + 1);
	}

	frame(report: Report, revision: RevisionId, sorting: string): string {
		const state = report.state.kind === 'open' ? 'open' : report.state.reason;
		const edits = this.#edits.get(revision) ?? 0;
		return `${sorting}:${String(edits)}:${state}:${String(report.lastActivityAt)}`;
	}

	/** A write count with the identity and external changes of this connection. */
	stamp(revision: RevisionId, writes: number, elsewhere: number | undefined): string {
		return elsewhere === undefined
			? randomUUID()
			: `${this.#instance}:${revision}:${String(elsewhere)}:${String(writes)}`;
	}
}
