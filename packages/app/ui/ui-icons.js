// @ts-check
// SPDX-License-Identifier: Apache-2.0 AND ISC
// Made by tools/make_ui_icons.py in the OpenStage Author repository, from its design/icons.json (the suite's one list of icons):
// do not edit by hand. Change that list and run the tool there with --assess pointing at this file.
// The icons of OpenAssess's own buttons, menus and command search: Lucide 1.56.0, kept as their drawn shapes, drawn as lines in the
// colour of the words around them, and hidden from screen readers (the words beside an icon, or a button's name, say what it is).
//
// ISC License
//
// Copyright (c) 2026 Lucide Icons and Contributors
//
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
//
// ---
//
// The following Lucide icons are derived from the Feather project:
//
// airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out
//
// The MIT License (MIT) (for the icons listed above)
//
// Copyright (c) 2013-present Cole Bemis
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/** @typedef {{ tag: string } & Record<string, string | number>} Shape */

export const UI_ICONS = /** @type {const} */ ({
  "check": [{"tag":"path","d":"M20 6 9 17l-5-5"}],
  "chevron-down": [{"tag":"path","d":"m6 9 6 6 6-6"}],
  "circle-check": [{"tag":"circle","cx":12,"cy":12,"r":10},{"tag":"path","d":"m16 9-5.5 5.5L8 12"}],
  "circle-dot": [{"tag":"circle","cx":12,"cy":12,"r":1},{"tag":"circle","cx":12,"cy":12,"r":10}],
  "clipboard-check": [{"tag":"rect","width":8,"height":4,"x":8,"y":2,"rx":1,"ry":1},{"tag":"path","d":"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"},{"tag":"path","d":"m9 14 2 2 4-4"}],
  "clipboard-list": [{"tag":"rect","width":8,"height":4,"x":8,"y":2,"rx":1,"ry":1},{"tag":"path","d":"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"},{"tag":"path","d":"M12 11h4"},{"tag":"path","d":"M12 16h4"},{"tag":"path","d":"M8 11h.01"},{"tag":"path","d":"M8 16h.01"}],
  "ellipsis": [{"tag":"circle","cx":12,"cy":12,"r":1},{"tag":"circle","cx":19,"cy":12,"r":1},{"tag":"circle","cx":5,"cy":12,"r":1}],
  "file-input": [{"tag":"path","d":"M4 11V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1"},{"tag":"path","d":"M14 2v5a1 1 0 0 0 1 1h5"},{"tag":"path","d":"M2 15h10"},{"tag":"path","d":"m9 18 3-3-3-3"}],
  "file-output": [{"tag":"path","d":"M4.226 20.925A2 2 0 0 0 6 22h12a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v3.127"},{"tag":"path","d":"M14 2v5a1 1 0 0 0 1 1h5"},{"tag":"path","d":"m5 11-3 3"},{"tag":"path","d":"m5 17-3-3h10"}],
  "file-plus": [{"tag":"path","d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"},{"tag":"path","d":"M14 2v5a1 1 0 0 0 1 1h5"},{"tag":"path","d":"M9 15h6"},{"tag":"path","d":"M12 18v-6"}],
  "file-text": [{"tag":"path","d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"},{"tag":"path","d":"M14 2v5a1 1 0 0 0 1 1h5"},{"tag":"path","d":"M10 9H8"},{"tag":"path","d":"M16 13H8"},{"tag":"path","d":"M16 17H8"}],
  "folder-open": [{"tag":"path","d":"m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"}],
  "folder-search": [{"tag":"path","d":"M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1"},{"tag":"path","d":"m21 21-1.9-1.9"},{"tag":"circle","cx":17,"cy":17,"r":3}],
  "folder-tree": [{"tag":"path","d":"M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"},{"tag":"path","d":"M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"},{"tag":"path","d":"M3 5a2 2 0 0 0 2 2h3"},{"tag":"path","d":"M3 3v13a2 2 0 0 0 2 2h3"}],
  "funnel-x": [{"tag":"path","d":"M12.531 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14v6a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341l.427-.473"},{"tag":"path","d":"m16.5 3.5 5 5"},{"tag":"path","d":"m21.5 3.5-5 5"}],
  "grid-3x3": [{"tag":"rect","width":18,"height":18,"x":3,"y":3,"rx":2},{"tag":"path","d":"M3 9h18"},{"tag":"path","d":"M3 15h18"},{"tag":"path","d":"M9 3v18"},{"tag":"path","d":"M15 3v18"}],
  "hash": [{"tag":"line","x1":4,"x2":20,"y1":9,"y2":9},{"tag":"line","x1":4,"x2":20,"y1":15,"y2":15},{"tag":"line","x1":10,"x2":8,"y1":3,"y2":21},{"tag":"line","x1":16,"x2":14,"y1":3,"y2":21}],
  "keyboard": [{"tag":"path","d":"M10 8h.01"},{"tag":"path","d":"M12 12h.01"},{"tag":"path","d":"M14 8h.01"},{"tag":"path","d":"M16 12h.01"},{"tag":"path","d":"M18 8h.01"},{"tag":"path","d":"M6 8h.01"},{"tag":"path","d":"M7 16h10"},{"tag":"path","d":"M8 12h.01"},{"tag":"rect","width":20,"height":16,"x":2,"y":4,"rx":2}],
  "library": [{"tag":"path","d":"m16 6 4 14"},{"tag":"path","d":"M12 6v14"},{"tag":"path","d":"M8 8v12"},{"tag":"path","d":"M4 4v16"}],
  "link": [{"tag":"path","d":"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"},{"tag":"path","d":"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"}],
  "list-checks": [{"tag":"path","d":"M13 5h8"},{"tag":"path","d":"M13 12h8"},{"tag":"path","d":"M13 19h8"},{"tag":"path","d":"m3 17 2 2 4-4"},{"tag":"path","d":"m3 7 2 2 4-4"}],
  "list-ordered": [{"tag":"path","d":"M11 5h10"},{"tag":"path","d":"M11 12h10"},{"tag":"path","d":"M11 19h10"},{"tag":"path","d":"M4 4h1v5"},{"tag":"path","d":"M4 9h2"},{"tag":"path","d":"M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02"}],
  "pencil": [{"tag":"path","d":"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"},{"tag":"path","d":"m15 5 4 4"}],
  "pencil-line": [{"tag":"path","d":"M13 21h8"},{"tag":"path","d":"m15 5 4 4"},{"tag":"path","d":"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"}],
  "plus": [{"tag":"path","d":"M5 12h14"},{"tag":"path","d":"M12 5v14"}],
  "printer": [{"tag":"path","d":"M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"},{"tag":"path","d":"M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"},{"tag":"rect","x":6,"y":14,"width":12,"height":8,"rx":1}],
  "refresh-cw": [{"tag":"path","d":"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"},{"tag":"path","d":"M21 3v5h-5"},{"tag":"path","d":"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"},{"tag":"path","d":"M8 16H3v5"}],
  "search": [{"tag":"path","d":"m21 21-4.34-4.34"},{"tag":"circle","cx":11,"cy":11,"r":8}],
  "text-cursor-input": [{"tag":"path","d":"M12 20h-1a2 2 0 0 1-2-2 2 2 0 0 1-2 2H6"},{"tag":"path","d":"M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7"},{"tag":"path","d":"M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1"},{"tag":"path","d":"M6 4h1a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1"},{"tag":"path","d":"M9 6v12"}],
  "trash": [{"tag":"path","d":"M10 11v6"},{"tag":"path","d":"M14 11v6"},{"tag":"path","d":"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"},{"tag":"path","d":"M3 6h18"},{"tag":"path","d":"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"}],
  "x": [{"tag":"path","d":"M18 6 6 18"},{"tag":"path","d":"m6 6 12 12"}],
});

/** @typedef {keyof typeof UI_ICONS} UiIconName */

// The name of the kind of element, which the browser needs to make one; it is never fetched.
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * An icon, drawn in the colour of the words beside it and hidden from screen readers.
 * @param {Document} doc
 * @param {UiIconName} name
 * @returns {SVGSVGElement}
 */
export function uiIcon(doc, name) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  for (const [k, v] of [["viewBox", "0 0 24 24"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["focusable", "false"], ["aria-hidden", "true"], ["class", "ui-icon"]]) svg.setAttribute(k, v);
  for (const shape of /** @type {readonly Shape[]} */ (UI_ICONS[name])) {
    const part = doc.createElementNS(SVG_NS, shape.tag);
    for (const [key, value] of Object.entries(shape)) if (key !== "tag") part.setAttribute(key, String(value));
    svg.appendChild(part);
  }
  return svg;
}
