/**
 * Matches a nested Lexical block (list, quote) that still carries its own
 * `dir`, but not the editor root itself — the root also carries `dir`
 * (ReactAutoDirectionPlugin sets it from the first strong character) and must
 * keep that value instead of inheriting from further out.
 */
export const NESTED_BLOCK_DIRECTION_SELECTOR = '[dir]:not([contenteditable])';
