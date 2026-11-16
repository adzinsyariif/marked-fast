# marked-fast

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/adzinsyariif/marked-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/adzinsyariif/marked-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

An entry for the make.fun bounty [“Make Markdown rendering faster”](https://make.fun/bounty/markdown-render-speed-02).

`parse.js` is a dependency-free Markdown renderer written from scratch. Its
`parse(markdown)` returns exactly the HTML that marked 18.1.3 renders with its
default options (GFM on), and it is built to produce that HTML faster than
marked itself: a single scanning pass over the source, small specialised
matchers instead of layered general regexes, and as few intermediate strings
as the output allows.

`main.ts` is the harness driver: it reads every case from `/input/cases.json`,
renders each one with `parse()`, and writes the HTML strings to
`/output/html.json` in order.

## Layout

- `parse.js` — the renderer (block engine, inline engine, HTML escaping).
- `main.ts` — the case-set driver the harness runs.
- `LICENSE` — MIT.
