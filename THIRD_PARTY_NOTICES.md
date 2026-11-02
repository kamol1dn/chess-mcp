# Third-party notices

## Chess piece artwork (`src/shared/pieces.ts`)

The piece shapes follow the "Cburnett" chess set by Colin M.L. Burnett, published on
Wikimedia Commons under a multi-license. Before redistributing, confirm that the
license you rely on (for example BSD or GPL) is compatible with your use, or
replace the artwork in `src/shared/pieces.ts` with a set of your choice. Every
renderer (PNG, SVG and the web UI) reads the pieces from that one file.

## DejaVu fonts (npm package `dejavu-fonts-ttf`)

Used to draw board coordinates in PNG images. Bitstream Vera / DejaVu font license
(free to use and redistribute); see `node_modules/dejavu-fonts-ttf/LICENSE`.

## npm dependencies

Runtime dependencies (`fastify`, `@fastify/*`, `@modelcontextprotocol/sdk`,
`@anthropic-ai/sdk`, `@resvg/resvg-js`, `commander`, `zod`) are MIT, Apache-2.0
or MPL-2.0 licensed; see each package's `LICENSE` file.
