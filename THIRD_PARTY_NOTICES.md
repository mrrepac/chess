# Third-party artwork

## Papercut chess pieces

- Artist: Nikolay Anzarov
- License: Creative Commons Attribution 4.0 International (CC BY 4.0)
- License text: https://creativecommons.org/licenses/by/4.0/
- Source: distributed with lichess, `public/piece/papercut` in
  https://github.com/lichess-org/lila — the attribution and license above are
  recorded in that repository's
  [COPYING.md](https://github.com/lichess-org/lila/blob/master/COPYING.md).

The white and black SVG pieces are embedded in the plugin bundle. The drawings
themselves are unmodified; the vendoring script (`vendor-pieces.mjs`) only
removes the Inkscape editor state each file carries — canvas settings and
`inkscape:`/`sodipodi:` attributes, which render nothing — and checks that the
element census of the drawing is unchanged afterwards.

The artwork remains licensed under CC BY 4.0, separately from the plugin's own
source code, which is MIT (see LICENSE).
