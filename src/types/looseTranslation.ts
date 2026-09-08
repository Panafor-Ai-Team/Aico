/**
 * Structural stand-in for react-i18next's `TFunction`.
 *
 * `TFunction<Ns>` narrows its key parameter to a literal union of that
 * namespace's keys, so it is *not* assignable to a hand-written
 * `(key: string) => string`. Helpers that merely forward a key and options
 * through — and that are called from several namespaces, or look keys up
 * dynamically — should accept this instead of declaring their own signature.
 *
 * The useful part of the contract is the `string` return; the parameters are
 * deliberately loose.
 */

export type LooseTFunction = (key: any, options?: any) => string;
