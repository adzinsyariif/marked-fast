// marked-fast driver: renders a whole case set in one pass.
//
// The harness starts this file as `node /bot/main.ts`. It loads every
// case from cases.json in the input directory, renders each case's
// markdown on its own with parse() from ./parse.js, and writes the
// resulting HTML strings, in the cases' order, as one JSON array to
// html.json in the output directory.
//
// Inside the grading container the directories are /input and /output;
// when the program runs outside a container the harness points at its
// own directories through MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

const inputDir: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw: string = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases: Case[] = JSON.parse(raw) as Case[];

const out: string[] = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  out[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
