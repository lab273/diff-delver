/**
 * Tiny types: every domain value has its own type, so a `LineNumber` cannot be
 * passed where a `ByteSize` is expected, and holding one means it was checked.
 *
 * A tiny type is made only by its parse function. Parse functions live in files
 * named `*.tiny.ts`, which are the only files where the lint config allows a type
 * assertion (`as`). Everywhere else a branded value can only come from parsing.
 */
declare const brand: unique symbol;

export type Tiny<T, Name extends string> = T & { readonly [brand]: Name };
