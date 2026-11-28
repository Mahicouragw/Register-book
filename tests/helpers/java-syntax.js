// A small Java lexer used by the tests.
//
// WHY: this project has no JDK in its test environment, so the .java files
// cannot be compiled here. They CAN be checked for the mistakes that actually
// cost a build: unbalanced braces or parens, and strings/comments that swallow
// the rest of a line.
//
// The subtlety that matters is ORDER. A naive checker strips `//` comments
// before strings, so a line containing "https://github.com" turns into
// unterminated rubbish and every count after it is wrong. This lexer walks the
// source once, left to right, and only treats `//` as a comment when it is not
// inside a string or character literal.

const fs = require("node:fs");

/**
 * Walks Java source and reports structural balance.
 * @returns {{depth:number, paren:number, negatives:string[], openBraces:number[]}}
 */
function balance(src) {
  let i = 0;
  let line = 1;
  let depth = 0;
  let paren = 0;
  const negative = [];
  const openBraces = [];
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === "\n") { line++; i++; continue; }

    // line comment
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // block comment
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    // string literal
    if (c === '"') {
      i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === '"' || src[i] === "\n") break;
        i++;
      }
      i++;
      continue;
    }
    // char literal
    if (c === "'") {
      i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "'" || src[i] === "\n") break;
        i++;
      }
      i++;
      continue;
    }

    if (c === "{") { depth++; openBraces.push(line); }
    else if (c === "}") {
      depth--;
      openBraces.pop();
      if (depth < 0) { negative.push("extra } at line " + line); depth = 0; }
    } else if (c === "(") paren++;
    else if (c === ")") {
      paren--;
      if (paren < 0) { negative.push("extra ) at line " + line); paren = 0; }
    }
    i++;
  }

  return { depth, paren, negatives: negative, openBraces };
}

/** True when the file's braces and parens all close. */
function isBalanced(file) {
  const r = balance(fs.readFileSync(file, "utf8"));
  return r.depth === 0 && r.paren === 0 && r.negatives.length === 0;
}

/** Every `type name` the file imports, as simple names. */
function importedSimpleNames(src) {
  const out = new Set();
  for (const m of src.matchAll(/^import\s+(?:static\s+)?([\w.]+);/gm)) {
    if (!m[1].endsWith("*")) out.add(m[1].split(".").pop());
  }
  return out;
}

module.exports = { balance, isBalanced, importedSimpleNames };
