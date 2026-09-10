/** Public surface of the pure core (no `vscode` anywhere below this file). */

export * from './types';
export * from './identifiers';
export * from './typeUtil';
export * from './layout';
export * from './validate';
export * from './codec';
export * from './emitBinary';
export * from './parseBinary';
export * from './emitHeader';
export * from './emitLayoutDoc';

import { Design } from './types';

/** Parse design JSON text, tolerating a leading BOM and `//` / `/* *\/` comments. */
export function parseDesignJson(text: string): Design {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(stripJsonComments(body)) as Design;
}

function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    const next = input[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += input[i + 1] ?? '';
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}
