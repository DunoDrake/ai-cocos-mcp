// Best-effort single-pass masking of string and line/block comment content so
// downstream regex-based scans never match text that only appears inside a
// comment or a string/template literal (e.g. a JSDoc mentioning `onDestroy()`,
// or a CSS-selector string like `'#header'`). Masked characters are replaced
// with a single space each, so line length/positions are preserved for any
// caller that still needs to compute an index into the original source.
//
// This is a heuristic, not a tokenizer: `${...}` interpolation inside a
// template literal is not re-entered as code (the whole backtick string is
// treated as inert), matching the tolerance already documented for the
// top-level-await heuristic this module backs.
export function maskSourceLines(text) {
  const lines = text.split('\n');
  const maskedLines = [];
  const depths = [];
  let depth = 0;
  let inBlockComment = false;
  let stringChar = null;

  for (const line of lines) {
    depths.push(depth);
    let masked = '';
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (inBlockComment) {
        if (ch === '*' && line[i + 1] === '/') {
          inBlockComment = false;
          masked += '  ';
          i += 2;
        } else {
          masked += ' ';
          i += 1;
        }
        continue;
      }
      if (stringChar) {
        if (ch === '\\') {
          masked += ' ';
          i += 1;
          if (i < line.length) {
            masked += ' ';
            i += 1;
          }
          continue;
        }
        if (ch === stringChar) stringChar = null;
        masked += ' ';
        i += 1;
        continue;
      }
      if (ch === '/' && line[i + 1] === '/') {
        masked += ' '.repeat(line.length - i);
        break;
      }
      if (ch === '/' && line[i + 1] === '*') {
        inBlockComment = true;
        masked += '  ';
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        stringChar = ch;
        masked += ' ';
        i += 1;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      masked += ch;
      i += 1;
    }
    maskedLines.push(masked);
  }
  return { lines, maskedLines, depths };
}

export function maskSourceText(text) {
  return maskSourceLines(text).maskedLines.join('\n');
}
