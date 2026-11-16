// marked-fast: a from-scratch Markdown renderer whose output matches
// marked 18.1.3 (default options: GFM on, breaks off, pedantic off)
// byte for byte, built to render the same HTML with less work.
//
// The module is dependency-free and pure: parse() computes everything
// from the string it is given and keeps no state between calls.
//
// Layout: small string helpers first, then the grammar (the rule
// expressions the scanners share), then the block engine, the inline
// engine, and the renderer that turns tokens into HTML.

// ---------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeChar = (ch) => ESCAPES[ch];

/** Escape &, <, >, ", ' the way marked does for code and attribute text. */
function escapeAll(text) {
  return /[&<>"']/.test(text) ? text.replace(/[&<>"']/g, escapeChar) : text;
}

/**
 * Escape like marked's running-text output: <, >, ", ' always, and &
 * only when it does not begin an entity-looking sequence.
 */
function escapeText(text) {
  return /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/.test(text)
    ? text.replace(/[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, escapeChar)
    : text;
}

/** Remove trailing characters equal to `ch` (marked's rtrim helper). */
function rtrimChar(str, ch) {
  let n = str.length;
  while (n > 0 && str.charAt(n - 1) === ch) n--;
  return n === str.length ? str : str.slice(0, n);
}

/**
 * Drop trailing blank lines from a block's raw text, the way marked
 * does for indented code and HTML blocks: if more than one line-end
 * follows the last content line, they all go.
 */
function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && /^[ \t]*$/.test(lines[last])) last--;
  return lines.length - last <= 2 ? str : lines.slice(0, last + 1).join('\n');
}

/** The lookup key for a link label: folded case, single spaces. */
function linkKey(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/**
 * Find the closing bracket for a run of `open`/`close` characters,
 * skipping backslash-escaped ones. Returns the index of the close
 * that balances the text, -1 when the pair never occurs, or -2 when
 * opens remain unbalanced.
 */
function findClosing(str, pair) {
  const open = pair[0], close = pair[1];
  if (str.indexOf(open) === -1 && str.indexOf(close) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === open) depth++;
    else if (str[i] === close && --depth < 0) return i;
  }
  return depth > 0 ? -2 : -1;
}

/**
 * Split a table row on unescaped pipes. Escaped pipes (\|) stay in
 * the cell text as literal pipes. When `cap` is given the row is
 * truncated or padded with empty cells to exactly `cap` cells.
 */
function splitRow(row, cap) {
  const marked = row.replace(/\|/g, (ch, offset, whole) => {
    let escaped = false, p = offset;
    while (--p >= 0 && whole[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = marked.split(/ \|/);
  if (cells.length > 0 && !cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (cap !== undefined) {
    if (cells.length > cap) cells.splice(cap);
    else while (cells.length < cap) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

/** Expand tabs to spaces, tab stops every 4 columns from `baseCol`. */
function expandTabs(text, baseCol = 0) {
  if (!text.includes('\t')) return text;
  let col = baseCol, out = '';
  for (const ch of text) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

/**
 * Decode numeric character references in running text (&#169; and
 * &#xA9;), replacing out-of-range values with U+FFFD and turning a
 * stray & that is not part of an entity into &amp;. Named references
 * are left alone; the renderer's escaper preserves them.
 */
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeNumericRefs(text) {
  if (!NUMERIC_REF.test(text)) return text;
  return text.replace(NUMERIC_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

/** The href normalisation marked applies: encodeURI, keeping % signs. */
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}


// ---------------------------------------------------------------------
// The grammar. These expressions state what each construct looks like;
// the engines below drive them. Block rules are tried in a fixed
// order; the first that matches at the current position wins.
// ---------------------------------------------------------------------

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const blockRule = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/,
  text: /^[^\n]+/,
};

blockRule.blockquote = /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/;

blockRule.html = /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$))/i;

blockRule.table = /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/;

blockRule.lheading = /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;

blockRule.paragraph = /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/;

const inlineRule = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  link: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/,
  reflink: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/,
  nolink: /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/,
  reflinkSearch: /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  urlBackpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
};

inlineRule.emStrongLDelim = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
inlineRule.emStrongRDelimAst = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
inlineRule.emStrongRDelimUnd = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
inlineRule.delLDelim = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
inlineRule.delRDelim = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
inlineRule.text = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/;

// Small shared tests and searches used by the engines.
const other = {
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetext: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteStrip: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerSpace: /^( {0,3}>)([ \t]+)/gm,
  taskTest: /^\[[ xX]\][ \t]+\S/,
  taskStrip: /^\[[ xX]\][ \t]+/,
  taskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  alignRight: /^ *-+: *$/,
  alignCenter: /^ *:-+: *$/,
  alignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  unicodeAlnum: /[\p{L}\p{N}]/u,
};

const listItemCache = new Map();
function listItemPattern(bulletSource) {
  let re = listItemCache.get(bulletSource);
  if (re === undefined) {
    re = new RegExp('^( {0,3}' + bulletSource + ')((?:[\\t ][^\\n]*)?(?:\\n|$))');
    listItemCache.set(bulletSource, re);
  }
  return re;
}
function clampedAt(indent) {
  // The lookahead helpers allow one column less than the item's
  // content indent (and never more than three columns).
  return Math.max(0, Math.min(3, indent - 1));
}
function indentPattern(indent, bodySource) {
  return new RegExp('^ {0,' + clampedAt(indent) + '}(?:' + bodySource + ')');
}
// The list-item loop rebuilds these lookaheads for every item; the
// indent range is tiny, so cache the compiled patterns by indent.
const indentCaches = {
  bullet: new Map(), hr: new Map(), fence: new Map(),
  head: new Map(), html: new Map(), quote: new Map(),
};
function cachedIndent(map, indent, build) {
  let re = map.get(indent);
  if (re === undefined) {
    re = build(indent);
    map.set(indent, re);
  }
  return re;
}
function nextBullet(indent) {
  return cachedIndent(indentCaches.bullet, indent, (i) =>
    new RegExp('^ {0,' + clampedAt(i) + '}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))'));
}
function hrAtIndent(indent) {
  return cachedIndent(indentCaches.hr, indent, (i) =>
    new RegExp('^ {0,' + clampedAt(i) + '}((?:-[ \\t]*){3,}|(?:_[\\t ]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)'));
}
function fencesAtIndent(indent) {
  return cachedIndent(indentCaches.fence, indent, (i) => indentPattern(i, '```|~~~'));
}
function headingAtIndent(indent) {
  return cachedIndent(indentCaches.head, indent, (i) => indentPattern(i, '#{1,6}(?:\\s|$)'));
}
function blockquoteAtIndent(indent) {
  return cachedIndent(indentCaches.quote, indent, (i) => indentPattern(i, '>'));
}
function htmlAtIndent(indent) {
  return cachedIndent(indentCaches.html, indent, (i) =>
    new RegExp('^ {0,' + clampedAt(i) + '}(?:</?(?:' + BLOCK_TAGS + ')(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i'));
}

// ---------------------------------------------------------------------
// Block engine. A lexer walks the source; at each step the first
// matching construct becomes a token and the source advances past it.
// Inline content is not lexed on the spot: queueInline() parks the
// text and returns the token array that the inline pass will fill
// once every block (and every link definition) is known.
// ---------------------------------------------------------------------

function queueInline(lx, src) {
  const tokens = [];
  lx.inlineQueue.push({ src, tokens });
  return tokens;
}

function spaceToken(src) {
  const cap = blockRule.newline.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
  return undefined;
}

function indentedCodeToken(src) {
  const cap = blockRule.code.exec(src);
  if (!cap) return undefined;
  const raw = trimTrailingBlankLines(cap[0]);
  const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
  return { type: 'code', raw, codeBlockStyle: 'indented', text };
}

/** Remove the fence indentation compensation from fenced code text. */
function fencedText(raw, content) {
  const indent = /^(\s+)(?:```)/.exec(raw);
  if (!indent) return content;
  const width = indent[1].length;
  return content.split('\n').map((line) => {
    const lead = /^\s+/.exec(line);
    if (!lead) return line;
    return line.slice(Math.min(lead[0].length, width));
  }).join('\n');
}

function fencedCodeToken(src) {
  const cap = blockRule.fences.exec(src);
  if (!cap) return undefined;
  const lang = cap[2] ? cap[2].trim().replace(inlineRule.anyPunctuation, '$1') : cap[2];
  return { type: 'code', raw: cap[0], lang, text: fencedText(cap[0], cap[3] || '') };
}

function headingToken(lx, src) {
  const cap = blockRule.heading.exec(src);
  if (!cap) return undefined;
  let text = cap[2].trim();
  if (/#$/.test(text)) {
    const stripped = rtrimChar(text, '#');
    if (stripped === '' || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return {
    type: 'heading',
    raw: rtrimChar(cap[0], '\n'),
    depth: cap[1].length,
    text,
    tokens: queueInline(lx, text),
  };
}

function hrToken(src) {
  const cap = blockRule.hr.exec(src);
  if (!cap) return undefined;
  return { type: 'hr', raw: rtrimChar(cap[0], '\n') };
}

function htmlToken(src) {
  const cap = blockRule.html.exec(src);
  if (!cap) return undefined;
  const raw = trimTrailingBlankLines(cap[0]);
  return {
    type: 'html',
    block: true,
    raw,
    pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
    text: raw,
  };
}

function defToken(src) {
  const cap = blockRule.def.exec(src);
  if (!cap) return undefined;
  if (cap[2].charAt(0) !== '<' && findClosing(cap[2], '()') !== -1) return undefined;
  const href = cap[2]
    ? cap[2].replace(/^<(.*)>$/, '$1').replace(inlineRule.anyPunctuation, '$1')
    : '';
  const title = cap[3]
    ? cap[3].substring(1, cap[3].length - 1).replace(inlineRule.anyPunctuation, '$1')
    : cap[3];
  return { type: 'def', tag: linkKey(cap[1]), raw: rtrimChar(cap[0], '\n'), href, title };
}

function tableToken(lx, src) {
  const cap = blockRule.table.exec(src);
  if (!cap || !/[:|]/.test(cap[2])) return undefined;
  const headerCells = splitRow(cap[1]);
  const alignCells = cap[2].replace(/^\||\| *$/g, '').split('|');
  const rowLines = cap[3] && cap[3].trim()
    ? cap[3].replace(/\n[ \t]*$/, '').split('\n')
    : [];
  if (headerCells.length !== alignCells.length) return undefined;
  const table = {
    type: 'table',
    raw: rtrimChar(cap[0], '\n'),
    header: [],
    align: [],
    rows: [],
  };
  for (const cell of alignCells) {
    table.align.push(
      other.alignRight.test(cell) ? 'right'
        : other.alignCenter.test(cell) ? 'center'
          : other.alignLeft.test(cell) ? 'left' : null,
    );
  }
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push({
      text: headerCells[i],
      tokens: queueInline(lx, headerCells[i]),
      header: true,
      align: table.align[i],
    });
  }
  for (const line of rowLines) {
    table.rows.push(splitRow(line, headerCells.length).map((cell, i) => ({
      text: cell,
      tokens: queueInline(lx, cell),
      header: false,
      align: table.align[i],
    })));
  }
  return table;
}

function setextToken(lx, src) {
  const cap = blockRule.lheading.exec(src);
  if (!cap) return undefined;
  const text = cap[1].trim();
  return {
    type: 'heading',
    raw: rtrimChar(cap[0], '\n'),
    depth: cap[2].charAt(0) === '=' ? 1 : 2,
    text,
    tokens: queueInline(lx, text),
  };
}

function paragraphToken(lx, src) {
  const cap = blockRule.paragraph.exec(src);
  if (!cap) return undefined;
  const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
  return { type: 'paragraph', raw: cap[0], text, tokens: queueInline(lx, text) };
}

function textToken(lx, src) {
  const cap = blockRule.text.exec(src);
  if (!cap) return undefined;
  return { type: 'text', raw: cap[0], text: cap[0], tokens: queueInline(lx, cap[0]) };
}

function blockquoteToken(lx, src) {
  const cap = blockRule.blockquote.exec(src);
  if (!cap) return undefined;
  let lines = rtrimChar(cap[0], '\n').split('\n');
  let raw = '', text = '';
  const tokens = [];
  while (lines.length > 0) {
    // One chunk: marker lines, plus any lazy lines before the first marker.
    let hasMarker = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (other.blockquoteStart.test(lines[p])) {
        chunk.push(lines[p]);
        hasMarker = true;
      } else if (!hasMarker) {
        chunk.push(lines[p]);
      } else break;
    }
    lines = lines.slice(p);
    const chunkRaw = chunk.join('\n');
    const stripped = chunkRaw
      .replace(other.blockquoteMarkerSpace, (m, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(other.blockquoteSetext, '\n    $1')
      .replace(other.blockquoteStrip, '');
    raw = raw ? raw + '\n' + chunkRaw : chunkRaw;
    text = text ? text + '\n' + stripped : stripped;
    const savedTop = lx.state.top;
    lx.state.top = true;
    blockTokens(lx, stripped, tokens, true);
    lx.state.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr'
      || last.type === 'html' || last.type === 'table')) {
      break;
    }
    if (last && last.type === 'blockquote') {
      const mergedSrc = last.raw + '\n' + lines.join('\n').replace(other.blockquoteStrip, '');
      const merged = blockquoteToken(lx, mergedSrc);
      tokens[tokens.length - 1] = merged;
      const leftover = mergedSrc.substring(merged.raw.length).replace(/^\n/, '');
      const leftoverLines = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
      if (consumed.length > 0) raw += '\n' + consumed.join('\n');
      text = text.substring(0, text.length - last.text.length) + merged.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && other.blockquoteStart.test(lines[0])) continue;
      break;
    }
    if (last && last.type === 'list') {
      const combined = last.raw + '\n' + lines.join('\n');
      const merged = listToken(lx, combined);
      tokens[tokens.length - 1] = merged;
      const extra = merged.raw.length > last.raw.length
        ? combined.slice(last.raw.length + 1, merged.raw.length).split('\n').length
        : 0;
      if (extra > 0) {
        const taken = lines.slice(0, extra).join('\n');
        raw += '\n' + taken;
        text += '\n' + taken;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}

function listToken(lx, src) {
  const first = blockRule.list.exec(src);
  if (!first) return undefined;
  const fullSrc = src;
  const consumed = () => fullSrc.length - src.length;
  const bullet = first[1].trim();
  const ordered = bullet.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bullet.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const bulletSource = ordered ? '\\d{1,9}\\' + bullet.slice(-1) : '\\' + bullet;
  const itemRe = listItemPattern(bulletSource);
  let blankLineSeen = false;

  const hrMatters = bullet === '-' || bullet === '*';
  let rest = src;
  while (rest) {
    const itemMatch = itemRe.exec(rest);
    if (!itemMatch || (hrMatters && blockRule.hr.test(rest))) break;
    const startIndex = consumed();
    rest = rest.substring(itemMatch[0].length);
    const bulletWidth = itemMatch[1].length;
    // Group 2 holds a single line plus its newline, if any.
    let content = itemMatch[2];
    if (content.endsWith('\n')) content = content.slice(0, -1);
    content = content.replace(/^[ \t]+/, (v) => expandTabs(v, bulletWidth));
    const nl0 = rest.indexOf('\n');
    let nextLine = nl0 < 0 ? rest : rest.slice(0, nl0);
    let isBlank = !content.trim();
    let itemText = '';
    let indent;
    if (isBlank) {
      indent = bulletWidth + 1;
    } else {
      indent = content.search(/[^ ]/);
      if (indent > 4) indent = 1;
      itemText = content.slice(indent);
      indent += bulletWidth;
    }
    let endsEarly = false;
    if (isBlank && other.blankLine.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      endsEarly = true;
    }
    if (!endsEarly) {
      const bulletRe = nextBullet(indent);
      const hrRe = hrAtIndent(indent);
      const fenceRe = fencesAtIndent(indent);
      const headRe = headingAtIndent(indent);
      const htmlRe = htmlAtIndent(indent);
      const quoteRe = blockquoteAtIndent(indent);
      const at = clampedAt(indent);
      while (rest) {
        const nl = rest.indexOf('\n');
        const line = nl < 0 ? rest : rest.slice(0, nl);
        const lead = line.charCodeAt(0);
        const expanded = lead === 32 || lead === 9
          ? line.replace(/^[ \t]+/, (v) => expandTabs(v, 0))
          : line;
        // All six lookaheads anchor on a specific character after at
        // most `at` spaces; skip them for ordinary text lines.
        let lsp = 0;
        while (line.charCodeAt(lsp) === 32) lsp++;
        const lfc = line.charCodeAt(lsp);
        const couldBreak = lsp <= at && (lfc === 96 || lfc === 126 || lfc === 35
          || lfc === 60 || lfc === 62 || lfc === 42 || lfc === 43 || lfc === 45
          || lfc === 95 || (lfc >= 48 && lfc <= 57));
        if (couldBreak && (fenceRe.test(line) || headRe.test(line) || htmlRe.test(line)
          || quoteRe.test(line) || bulletRe.test(line) || hrRe.test(line))) {
          break;
        }
        if (expanded.search(/[^ ]/) >= indent || !line.trim()) {
          itemText += '\n' + expanded.slice(indent);
        } else {
          if (isBlank
            || content.replace(/\t/g, '    ').search(/[^ ]/) >= 4
            || fenceRe.test(content) || headRe.test(content)
            || htmlRe.test(content) || hrRe.test(content)) {
            break;
          }
          const asSetext = /^ {0,3}(?:=+|-+) *$/.test(line)
            && blockRule.lheading.test(content + '\n' + line)
            ? '    ' + expanded.replace(/^ {0,3}/, '')
            : line;
          itemText += '\n' + asSetext;
        }
        isBlank = !line.trim();
        rest = rest.substring(line.length + 1);
        content = expanded.slice(indent);
      }
    }
    src = rest;
    const itemRaw = fullSrc.slice(startIndex, consumed());
    if (!list.loose) {
      if (blankLineSeen) list.loose = true;
      else if (endsWithBlankLine(itemRaw)) blankLineSeen = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: other.taskTest.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }

  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return undefined;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = fullSrc.slice(0, consumed()).trimEnd();

  for (const item of list.items) {
    lx.state.top = false;
    item.tokens = blockTokens(lx, item.text, []);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      list.loose = spaces.length > 0 && spaces.some((t) => other.anyLine.test(t.raw));
    }
  }
  for (const item of list.items) {
    const head = item.tokens[0];
    if (item.task && head && (head.type === 'text' || head.type === 'paragraph')) {
      item.text = item.text.replace(other.taskStrip, '');
      head.raw = head.raw.replace(other.taskStrip, '');
      head.text = head.text.replace(other.taskStrip, '');
      for (let g = lx.inlineQueue.length - 1; g >= 0; g--) {
        if (other.taskTest.test(lx.inlineQueue[g].src)) {
          lx.inlineQueue[g].src = lx.inlineQueue[g].src.replace(other.taskStrip, '');
          break;
        }
      }
      const checkboxMatch = other.taskCheckbox.exec(item.raw);
      if (checkboxMatch) {
        const checkbox = {
          type: 'checkbox',
          raw: checkboxMatch[0] + ' ',
          checked: checkboxMatch[0] !== '[ ]',
        };
        item.checked = checkbox.checked;
        if (list.loose) {
          if (head && (head.type === 'paragraph' || head.type === 'text') && head.tokens) {
            head.raw = checkbox.raw + head.raw;
            head.text = checkbox.raw + head.text;
            head.tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({
              type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox],
            });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) {
        if (tok.type === 'text') tok.type = 'paragraph';
      }
    }
  }
  return list;
}

// The block driver: try each construct in order at the head of the
// remaining source. A few constructs merge into a preceding paragraph
// or text token instead of standing alone (an indented code block or
// a link definition that directly follows paragraph text, and the
// first paragraph of a blockquote chunk continuing the previous one).
/** Whether the text ends with a blank line: \n, optional blanks, \n, optional blanks, end. */
function endsWithBlankLine(text) {
  let i = text.length;
  while (i > 0 && (text.charCodeAt(i - 1) === 32 || text.charCodeAt(i - 1) === 9)) i--;
  if (i < 1 || text.charCodeAt(i - 1) !== 10) return false;
  i--;
  while (i > 0 && (text.charCodeAt(i - 1) === 32 || text.charCodeAt(i - 1) === 9)) i--;
  return i > 0 && text.charCodeAt(i - 1) === 10;
}

/** Whether `src` at offset `sp` starts an ordered-list number: 1-9 digits followed by '.' or ')'. */
function isListNumber(src, sp, fc) {
  if (fc < 48 || fc > 57) return false;
  let i = sp;
  while (src.charCodeAt(i) >= 48 && src.charCodeAt(i) <= 57) i++;
  if (i - sp > 9) return false;
  const after = src.charCodeAt(i);
  return after === 46 || after === 41;
}

/** A table needs a second line (the delimiter row), which must contain at least one '-'. */
function couldBeTable(src) {
  const nl = src.indexOf('\n');
  if (nl < 0) return false;
  const nl2 = src.indexOf('\n', nl + 1);
  const line2 = nl2 < 0 ? src.slice(nl + 1) : src.slice(nl + 1, nl2);
  return line2.includes('-');
}

function blockTokens(lx, src, tokens, lastParagraphClipped = false) {
  let prevLen = Infinity;
  while (src) {
    if (src.length < prevLen) prevLen = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let tok;
    const prev = () => tokens[tokens.length - 1];
    const lastQueue = () => lx.inlineQueue[lx.inlineQueue.length - 1];

    if (tok = spaceToken(src)) {
      src = src.substring(tok.raw.length);
      if (tok.raw.length === 1 && tokens.length > 0) prev().raw += '\n';
      else tokens.push(tok);
      continue;
    }
    // First-significant-character guards: each block pattern allows
    // up to three leading spaces and then requires a specific
    // character, so tokenizers that cannot match are skipped. The
    // relative order of the remaining tokenizers is unchanged.
    let sp = 0;
    while (src.charCodeAt(sp) === 32) sp++;
    const fc = src.charCodeAt(sp);
    const atMost3 = sp <= 3;
    if ((sp >= 4 || fc === 9) && (tok = indentedCodeToken(src))) {
      src = src.substring(tok.raw.length);
      const p = prev();
      if (p && (p.type === 'paragraph' || p.type === 'text')) {
        p.raw += (p.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        p.text += '\n' + tok.text;
        lastQueue().src = p.text;
      } else tokens.push(tok);
      continue;
    }
    if (atMost3 && (fc === 96 || fc === 126) && (tok = fencedCodeToken(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (atMost3 && fc === 35 && (tok = headingToken(lx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (atMost3 && (fc === 45 || fc === 95 || fc === 42) && (tok = hrToken(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (atMost3 && fc === 62 && (tok = blockquoteToken(lx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (atMost3 && (fc === 42 || fc === 43 || fc === 45 || isListNumber(src, sp, fc)) && (tok = listToken(lx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (atMost3 && fc === 60 && (tok = htmlToken(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (atMost3 && fc === 91 && (tok = defToken(src))) {
      src = src.substring(tok.raw.length);
      const p = prev();
      if (p && (p.type === 'paragraph' || p.type === 'text')) {
        p.raw += (p.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        p.text += '\n' + tok.raw;
        lastQueue().src = p.text;
      } else {
        if (!(tok.tag in lx.links)) lx.links[tok.tag] = { href: tok.href, title: tok.title };
        tokens.push(tok);
      }
      continue;
    }
    if (couldBeTable(src) && (tok = tableToken(lx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (tok = setextToken(lx, src)) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (lx.state.top && (tok = paragraphToken(lx, src))) {
      src = src.substring(tok.raw.length);
      const p = prev();
      if (lastParagraphClipped && p && p.type === 'paragraph') {
        p.raw += (p.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        p.text += '\n' + tok.text;
        lx.inlineQueue.pop();
        lastQueue().src = p.text;
      } else tokens.push(tok);
      lastParagraphClipped = false;
      continue;
    }
    if (tok = textToken(lx, src)) {
      src = src.substring(tok.raw.length);
      const p = prev();
      if (p && p.type === 'text') {
        p.raw += (p.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        p.text += '\n' + tok.text;
        lx.inlineQueue.pop();
        lastQueue().src = p.text;
      } else tokens.push(tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  lx.state.top = true;
  return tokens;
}

// ---------------------------------------------------------------------
// Inline engine. Emphasis and strikethrough are resolved against a
// masked copy of the text: link destinations, code spans, HTML tags
// and escaped punctuation are blanked out (same length, dummy
// letters), so a delimiter inside them cannot be mistaken for one in
// the open. The mask is rebuilt for every inline run.
// ---------------------------------------------------------------------

function linkInText(lx, text) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(inlineRule.blockSkip)) {
    if (inlineRule.link.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(inlineRule.reflinkSearch)) {
    const s = m[0];
    const open = s.lastIndexOf('[');
    const isRef = !(s.charAt(0) === '!'
      || !Object.hasOwn(lx.links, linkKey(s.slice(open + 1, -1))));
    if (isRef && !(open > 1 && linkInText(lx, s.slice(1, open - 1)))) return true;
  }
  return false;
}

function maskInline(lx, src) {
  let masked = src;
  if (src.includes('[') && Object.keys(lx.links).length > 0) {
    const maskRef = (match) => {
      const open = match.lastIndexOf('[');
      if (!Object.hasOwn(lx.links, linkKey(match.slice(open + 1, -1)))) return match;
      if (open > 1 && match.charAt(0) !== '!') {
        const inner = match.slice(1, open - 1);
        if (linkInText(lx, inner)) {
          return '[' + inner.replace(inlineRule.reflinkSearch, maskRef)
            + '][' + 'a'.repeat(match.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match.length - 2) + ']';
    };
    masked = masked.replace(inlineRule.reflinkSearch, maskRef);
  }
  if (masked.includes('\\') || masked.includes('`')) {
    masked = masked.replace(inlineRule.anyPunctuationOutsideCode, (m, ticks, esc) => {
      if (esc) return '+'.repeat(m.length);
      if (ticks) {
        return ticks
          + m.slice(ticks.length, m.length - ticks.length).replace(/`/g, '+')
          + ticks;
      }
      return m;
    });
  }
  if (!masked.includes('<') && !masked.includes('`') && !masked.includes('[')) return masked;
  masked = masked.replace(inlineRule.blockSkip, (m, ga, emptyGroup) => {
    const keep = emptyGroup ? emptyGroup.length : 0;
    return m.slice(0, keep) + '[' + 'a'.repeat(m.length - keep - 2) + ']';
  });
  return masked;
}

/**
 * For each of *, _ and ~, the last index in the masked text where a
 * run of that character could close emphasis: a run whose preceding
 * character is not blank. -1 when there is none.
 */
function lastCloserIndexes(masked) {
  const last = { '*': -1, '_': -1, '~': -1 };
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const ch = masked[s];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const before = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === ch) i++;
    if (before !== ' ' && before !== '\t' && before !== '\n'
      && before !== '\r' && before !== '\f') {
      last[ch] = s;
    }
    s = i - 1;
  }
  return last;
}

/** True when an HTML tag inside a would-be link text crosses its end. */
function tagCrossesLinkText(src, text, offset) {
  if (!text.includes('<')) return false;
  for (let s = 0; s < text.length; s++) {
    if (text[s] === '\\') { s++; continue; }
    if (text[s] === '`') {
      const m = inlineRule.code.exec(text.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (text[s] !== '<') continue;
    const m = inlineRule.tag.exec(src.slice(offset + s))
      || inlineRule.autolink.exec(src.slice(offset + s));
    if (m) {
      if (m[0].length > text.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

/**
 * Build a link or image token from a successful match, lexing the
 * text inline. A link whose text itself emits a link is rejected
 * (links cannot nest); images may contain links.
 */
function outputLink(lx, cap, link, raw) {
  const text = cap[1].replace(/\\([\[\]])/g, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const prevInLink = lx.state.inLink;
  const prevEmitted = lx.state.linkEmitted;
  const prevRawBlock = lx.state.inRawBlock;
  lx.state.inLink = true;
  lx.state.linkEmitted = false;
  const tokens = inlineTokens(lx, text, []);
  const emittedInside = lx.state.linkEmitted;
  lx.state.linkEmitted = prevEmitted;
  lx.state.inLink = prevInLink;
  if (!isImage) {
    if (emittedInside) {
      lx.state.inRawBlock = prevRawBlock;
      return undefined;
    }
    lx.state.linkEmitted = true;
  }
  return {
    type: isImage ? 'image' : 'link',
    raw,
    href: link.href,
    title: link.title || null,
    text,
    tokens,
  };
}

function escapeToken(src) {
  const cap = inlineRule.escape.exec(src);
  if (!cap) return undefined;
  return { type: 'escape', raw: cap[0], text: cap[1] };
}

function tagToken(lx, src) {
  const cap = inlineRule.tag.exec(src);
  if (!cap) return undefined;
  if (!lx.state.inLink && other.startATag.test(cap[0])) lx.state.inLink = true;
  else if (lx.state.inLink && other.endATag.test(cap[0])) lx.state.inLink = false;
  if (!lx.state.inRawBlock && other.startPreTag.test(cap[0])) lx.state.inRawBlock = true;
  else if (lx.state.inRawBlock && other.endPreTag.test(cap[0])) lx.state.inRawBlock = false;
  return {
    type: 'html', raw: cap[0], block: false, text: cap[0],
    inLink: lx.state.inLink, inRawBlock: lx.state.inRawBlock,
  };
}

function linkToken(lx, src) {
  if (lx.state.linkParenPossible === false) return undefined;
  const cap = inlineRule.link.exec(src);
  if (!cap) return undefined;
  if (tagCrossesLinkText(src, cap[1], cap[0].charAt(0) === '!' ? 2 : 1)) return undefined;
  const trimmedHref = cap[2].trim();
  if (trimmedHref.startsWith('<')) {
    if (!/>$/.test(trimmedHref)) return undefined;
    const stripped = rtrimChar(trimmedHref.slice(0, -1), '\\');
    if ((trimmedHref.length - stripped.length) % 2 === 0) return undefined;
  } else {
    const closeIdx = findClosing(cap[2], '()');
    if (closeIdx === -2) return undefined;
    if (closeIdx > -1) {
      const prefixLen = (cap[0].indexOf('!') === 0 ? 5 : 4) + cap[1].length + closeIdx;
      cap[2] = cap[2].substring(0, closeIdx);
      cap[0] = cap[0].substring(0, prefixLen).trim();
      cap[3] = '';
    }
  }
  const strippedRaw = rtrimChar(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - strippedRaw.length) % 2 === 0) return undefined;
  let href = cap[2].trim();
  if (href.startsWith('<')) href = href.slice(1, -1);
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  return outputLink(lx, cap, {
    href: href && href.replace(inlineRule.anyPunctuation, '$1'),
    title: title && title.replace(inlineRule.anyPunctuation, '$1'),
  }, cap[0]);
}

function reflinkToken(lx, src) {
  const cap = inlineRule.reflink.exec(src) || inlineRule.nolink.exec(src);
  if (!cap) return undefined;
  if (tagCrossesLinkText(src, cap[1], cap[0].charAt(0) === '!' ? 2 : 1)) return undefined;
  const link = lx.links[linkKey(cap[2] || cap[1])];
  if (!link) {
    const firstChar = cap[0].charAt(0);
    return { type: 'text', raw: firstChar, text: firstChar };
  }
  return outputLink(lx, cap, link, cap[0]);
}

function codespanToken(src) {
  const cap = inlineRule.code.exec(src);
  if (!cap) return undefined;
  let text = cap[2].replace(/\n/g, ' ');
  if (/[^ ]/.test(text) && /^ /.test(text) && / $/.test(text)) {
    text = text.substring(1, text.length - 1);
  }
  return { type: 'codespan', raw: cap[0], text };
}

function brToken(src) {
  const cap = inlineRule.br.exec(src);
  if (!cap) return undefined;
  return { type: 'br', raw: cap[0] };
}

function autolinkToken(src) {
  const cap = inlineRule.autolink.exec(src);
  if (!cap) return undefined;
  const text = cap[1];
  const href = cap[2] === '@' ? 'mailto:' + text : text;
  return {
    type: 'link', raw: cap[0], text, href, autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
}

function urlToken(src) {
  const cap = inlineRule.url.exec(src);
  if (!cap) return undefined;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + cap[0];
  } else {
    let prev;
    do {
      prev = cap[0];
      const m = inlineRule.urlBackpedal.exec(cap[0]);
      cap[0] = m ? m[0] : '';
    } while (prev !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return {
    type: 'link', raw: cap[0], text, href, autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
}

function inlineTextToken(lx, src) {
  const cap = inlineRule.text.exec(src);
  if (!cap) return undefined;
  const inRaw = lx.state.inRawBlock;
  return {
    type: 'text',
    raw: cap[0],
    text: inRaw ? cap[0] : decodeNumericRefs(cap[0]),
    escaped: inRaw,
  };
}

/**
 * Emphasis and strong emphasis. The opening delimiter run is matched
 * at the head of `src`; the search for its closer runs over the
 * masked text, following the same bookkeeping marked uses: runs that
 * look like openers add to the balance, the rule of three can skip a
 * closer, and whatever remains decides between <em> and <strong>.
 */
function emStrongToken(lx, src, masked, prevChar, closers) {
  const match = inlineRule.emStrongLDelim.exec(src);
  if (!match || (!match[1] && !match[2] && !match[3] && !match[4])) return undefined;
  const delimChar = src.charAt(0);
  const sameAsPrev = prevChar === delimChar;
  const offset = masked.length - src.length;
  let runStart = offset;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const charBefore = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const beforeIsPunct = charBefore === '*' || charBefore === '_'
    || !!inlineRule.punctuation.exec(charBefore);
  let effectivePrev = prevChar;
  if (runStart < offset) effectivePrev = charBefore;
  const prevIsPunct = runStart < offset
    ? beforeIsPunct
    : !!inlineRule.punctuation.exec(prevChar);
  if (match[4] && other.unicodeAlnum.test(effectivePrev)) return undefined;
  const nextPunct = match[1] || match[3] || '';
  if (nextPunct && effectivePrev && !prevIsPunct) return undefined;

  let openerLen = [...match[0]].length - 1;
  let remaining = openerLen;
  let skipped = 0;
  const runLength = offset - runStart + openerLen;
  const canOpenAfter = !!charBefore.trim()
    && (!!nextPunct || (delimChar === '*' && !beforeIsPunct));
  const rule = delimChar === '*'
    ? inlineRule.emStrongRDelimAst
    : inlineRule.emStrongRDelimUnd;
  const lastCloser = closers[delimChar];
  const afterOpener = offset + openerLen;
  if (lastCloser < afterOpener) return undefined;
  const restMasked = masked.slice(offset + openerLen);
  const lastRel = lastCloser - afterOpener;
  rule.lastIndex = 0;
  let m2;
  while ((m2 = rule.exec(restMasked)) !== null && m2.index <= lastRel) {
    const g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
    if (!g) continue;
    let closerLen = [...g].length;
    if (m2[3] || m2[4]) {
      remaining += closerLen;
      continue;
    }
    if (m2[5] || m2[6] || canOpenAfter) {
      if (sameAsPrev && (m2[5] || m2[6])) break;
      if (runLength % 3 && !((runLength + closerLen) % 3)) {
        skipped += closerLen;
        continue;
      }
    }
    remaining -= closerLen;
    if (remaining > 0) continue;
    closerLen = Math.min(closerLen, closerLen + remaining + skipped);
    const firstCharLen = [...m2[0]][0].length;
    const raw = src.slice(0, openerLen + m2.index + firstCharLen + closerLen);
    if (Math.min(openerLen, closerLen) % 2) {
      const text = raw.slice(1, -1);
      return { type: 'em', raw, text, tokens: inlineTokens(lx, text, []) };
    }
    const text = raw.slice(2, -2);
    return { type: 'strong', raw, text, tokens: inlineTokens(lx, text, []) };
  }
  return undefined;
}

/** Strikethrough: the same closer search, with ~ runs of equal size. */
function delToken(lx, src, masked, prevChar, closers) {
  const match = inlineRule.delLDelim.exec(src);
  if (!match) return undefined;
  if (match[1] && prevChar && !inlineRule.punctuation.exec(prevChar)) return undefined;
  const openerLen = [...match[0]].length - 1;
  let remaining = openerLen;
  const lastCloser = closers['~'];
  const afterOpener = masked.length - src.length + openerLen;
  if (lastCloser < afterOpener) return undefined;
  const restMasked = masked.slice(masked.length - src.length + openerLen);
  const lastRel = lastCloser - afterOpener;
  const rule = inlineRule.delRDelim;
  rule.lastIndex = 0;
  let m2;
  while ((m2 = rule.exec(restMasked)) !== null && m2.index <= lastRel) {
    const g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
    if (!g) continue;
    let len = [...g].length;
    if (len !== openerLen) continue;
    if (m2[3] || m2[4]) {
      remaining += len;
      continue;
    }
    remaining -= len;
    if (remaining > 0) continue;
    len = Math.min(len, len + remaining);
    const firstCharLen = [...m2[0]][0].length;
    const raw = src.slice(0, openerLen + m2.index + firstCharLen + len);
    const text = raw.slice(openerLen, raw.length - openerLen);
    return { type: 'del', raw, text, tokens: inlineTokens(lx, text, []) };
  }
  return undefined;
}

function inlineTokens(lx, src, tokens) {
  const savedParen = lx.state.linkParenPossible;
  if (!savedParen) return inlineTokensInner(lx, src, tokens);
  lx.state.linkParenPossible = src.includes(')');
  try {
    return inlineTokensInner(lx, src, tokens);
  } finally {
    lx.state.linkParenPossible = savedParen;
  }
}

const schemePrefix = /^(?:https?|ftp):\/\//i;

/**
 * Whether the url tokenizer could match at the head of `src`: one of
 * its prefixes (scheme, www., mailto:, xmpp:) or an email-shaped run
 * of local-part characters immediately followed by '@'.
 */
function mightBeUrl(src, c) {
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
    || c === 46 || c === 95 || c === 43 || c === 45) {
    let i = 0;
    const n = src.length;
    while (i < n) {
      const ch = src.charCodeAt(i);
      if ((ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)
        || ch === 46 || ch === 95 || ch === 43 || ch === 45) i++;
      else break;
    }
    if (i > 0 && src.charCodeAt(i) === 64) return true;
  }
  if (c === 104 || c === 72 || c === 102 || c === 70) return schemePrefix.test(src);
  if (c === 119) return src.startsWith('www.');
  if (c === 109) return src.startsWith('mailto:');
  if (c === 120) return src.startsWith('xmpp:');
  return false;
}

function inlineTokensInner(lx, src, tokens) {
  const hasDelims = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = hasDelims ? maskInline(lx, src) : src;
  const closers = hasDelims ? lastCloserIndexes(masked) : null;
  let prevChar = '';
  let afterText = false;
  let prevLen = Infinity;
  let rest = src;
  while (rest) {
    if (rest.length < prevLen) prevLen = rest.length;
    else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    if (!afterText) prevChar = '';
    afterText = false;
    let tok;
    // First-character dispatch: every tokenizer's pattern can only
    // start with specific characters, so at each position only the
    // tokenizers that could match are tried, in the original order.
    const c = rest.charCodeAt(0);
    if (c === 92) { // backslash: escape, then hard break
      if (tok = escapeToken(rest)) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (tok = brToken(rest)) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    } else if (c === 60) { // '<': tag, then autolink
      if (tok = tagToken(lx, rest)) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (tok = autolinkToken(rest)) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    } else if (c === 91 || c === 33) { // '[' or '!': link, then reflink
      if (tok = linkToken(lx, rest)) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (tok = reflinkToken(lx, rest)) {
        rest = rest.substring(tok.raw.length);
        const p = tokens[tokens.length - 1];
        if (tok.type === 'text' && p && p.type === 'text') {
          p.raw += tok.raw;
          p.text += tok.text;
        } else tokens.push(tok);
        continue;
      }
    } else if (c === 42 || c === 95) { // '*' or '_': emphasis
      if (tok = emStrongToken(lx, rest, masked, prevChar, closers)) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    } else if (c === 96) { // '`': code span
      if (tok = codespanToken(rest)) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    } else if (c === 126) { // '~': strikethrough
      if (tok = delToken(lx, rest, masked, prevChar, closers)) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    } else if (c === 32) { // ' ': hard break only
      if (tok = brToken(rest)) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
    }
    if (!lx.state.inLink && mightBeUrl(rest, c) && (tok = urlToken(rest))) {
      rest = rest.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (tok = inlineTextToken(lx, rest)) {
      rest = rest.substring(tok.raw.length);
      if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
      afterText = true;
      const p = tokens[tokens.length - 1];
      if (p && p.type === 'text') {
        p.raw += tok.raw;
        p.text += tok.text;
      } else tokens.push(tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
  }
  return tokens;
}

// ---------------------------------------------------------------------
// Renderer: tokens to HTML, with marked's exact shapes and spacing.
// ---------------------------------------------------------------------

function renderTextPlain(tokens) {
  // The plain-text rendering used for image alt text: inline tokens
  // contribute their text, links and emphasis their inner text.
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += tok.tokens ? renderTextPlain(tok.tokens) : tok.text;
        break;
      case 'codespan':
      case 'html':
      case 'text':
      case 'escape':
        out += tok.text;
        break;
      case 'br':
        break;
      case 'checkbox':
        out += tok.raw;
        break;
      default:
        out += tok.text ?? '';
    }
  }
  return out;
}

function renderInline(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape':
        out += escapeText(tok.text);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'link': {
        const inner = tok.autolink ? escapeAll(tok.text) : renderInline(tok.tokens);
        const href = cleanUrl(tok.href);
        if (href === null) { out += inner; break; }
        let tag = '<a href="' + (tok.autolink ? escapeAll(href) : escapeText(href)) + '"';
        if (tok.title) tag += ' title="' + escapeText(tok.title) + '"';
        out += tag + '>' + inner + '</a>';
        break;
      }
      case 'image': {
        const alt = tok.tokens ? renderTextPlain(tok.tokens) : tok.text;
        const href = cleanUrl(tok.href);
        if (href === null) { out += escapeText(alt); break; }
        let tag = '<img src="' + escapeText(href) + '" alt="' + escapeText(alt) + '"';
        if (tok.title) tag += ' title="' + escapeText(tok.title) + '"';
        out += tag + '>';
        break;
      }
      case 'strong':
        out += '<strong>' + renderInline(tok.tokens) + '</strong>';
        break;
      case 'em':
        out += '<em>' + renderInline(tok.tokens) + '</em>';
        break;
      case 'codespan':
        out += '<code>' + escapeAll(tok.text) + '</code>';
        break;
      case 'br':
        out += '<br>';
        break;
      case 'del':
        out += '<del>' + renderInline(tok.tokens) + '</del>';
        break;
      case 'checkbox':
        out += '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'text':
        out += tok.tokens
          ? renderInline(tok.tokens)
          : tok.escaped ? tok.text : escapeText(tok.text);
        break;
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return open + renderInline(cell.tokens) + `</${tag}>\n`;
}

function renderBlocks(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${tok.depth}>` + renderInline(tok.tokens) + `</h${tok.depth}>\n`;
        break;
      case 'code': {
        const langWord = (tok.lang || '').match(/^\S*/)[0];
        const body = tok.text ? escapeAll(tok.text.replace(/\n$/, '') + '\n') : '';
        out += langWord
          ? '<pre><code class="language-' + escapeText(langWord) + '">' + body + '</code></pre>\n'
          : '<pre><code>' + body + '</code></pre>\n';
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of tok.header) head += renderTableCell(cell);
        let bodyHtml = '';
        for (const row of tok.rows) {
          let rowHtml = '';
          for (const cell of row) rowHtml += renderTableCell(cell);
          bodyHtml += '<tr>\n' + rowHtml + '</tr>\n';
        }
        out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n'
          + (bodyHtml ? '<tbody>' + bodyHtml + '</tbody>' : '')
          + '</table>\n';
        break;
      }
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(tok.tokens) + '</blockquote>\n';
        break;
      case 'list': {
        let items = '';
        for (const item of tok.items) {
          items += '<li>' + renderBlocks(item.tokens) + '</li>\n';
        }
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        out += '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
        break;
      }
      case 'checkbox':
        out += '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'html':
        out += tok.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += '<p>' + renderInline(tok.tokens) + '</p>\n';
        break;
      case 'text':
        out += tok.tokens
          ? renderInline(tok.tokens)
          : tok.escaped ? tok.text : escapeText(tok.text);
        break;
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

/**
 * Render `markdown` to HTML exactly as marked.parse would with
 * default options. Pure: all lexer state is created per call.
 */
export function parse(markdown) {
  const lx = {
    links: Object.create(null),
    inlineQueue: [],
    state: {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    },
  };
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const tokens = blockTokens(lx, src, []);
  for (let i = 0; i < lx.inlineQueue.length; i++) {
    const entry = lx.inlineQueue[i];
    lx.state.inRawBlock = false;
    inlineTokens(lx, entry.src, entry.tokens);
  }
  lx.inlineQueue = [];
  return renderBlocks(tokens);
}
