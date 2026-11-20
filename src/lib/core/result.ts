/**
 * Expected failures are values, not exceptions. A function that can fail in a way
 * the caller should handle returns a `Result` with a typed error union.
 */
export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
	readonly ok: true;
	readonly value: T;
}

export interface Err<E> {
	readonly ok: false;
	readonly error: E;
}

export function ok<T>(value: T): Ok<T> {
	return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
	return { ok: false, error };
}

/** Transforms the value of a success and passes a failure through unchanged. */
export function map<T, U, E>(result: Result<T, E>, f: (value: T) => U): Result<U, E> {
	return result.ok ? ok(f(result.value)) : result;
}

/** Chains a step that can itself fail. */
export function andThen<T, U, E, F>(
	result: Result<T, E>,
	f: (value: T) => Result<U, F>
): Result<U, E | F> {
	return result.ok ? f(result.value) : result;
}

/** Transforms the error of a failure and passes a success through unchanged. */
export function mapErr<T, E, F>(result: Result<T, E>, f: (error: E) => F): Result<T, F> {
	return result.ok ? result : err(f(result.error));
}

/** Returns the value of a success, or the fallback for a failure. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
	return result.ok ? result.value : fallback;
}
