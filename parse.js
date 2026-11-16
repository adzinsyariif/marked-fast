// marked-fast: a from-scratch Markdown renderer whose output matches
// marked 18.1.3 (default options: GFM on, breaks off, pedantic off)
// byte for byte, built to render the same HTML with less work.
//
// The module is dependency-free and pure: parse() computes everything
// from the string it is given and keeps no state between calls.

/** Escape the characters marked escapes in text content. */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Render `markdown` to HTML exactly as marked.parse would.
 * Skeleton stage: plain paragraphs only; block and inline engines
 * are filled in below as they are written.
 */
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  if (src.trim() === '') return '';
  return '<p>' + escapeHtml(src.replace(/\n+$/, '')) + '</p>\n';
}
