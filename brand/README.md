# Brand assets

`OpenAssess.svg` is the source of truth. Everything in `icons/` is generated
from it, so change the SVG and regenerate rather than editing a PNG.

The artwork is a clipboard with three answer choices and a checkmark, in the
suite's orange on the shared navy tile. The tile's outer corners are
transparent, so every PNG here has an alpha channel and none of them should be
flattened onto white.

## What is here

| File | Used for |
| --- | --- |
| `OpenAssess.svg` | The editable original, 1024 square |
| `icons/icon.png` | 1024 square, the source Tauri regenerates from |
| `icons/icon.ico` | Windows, with 16, 24, 32, 48, 64, 128 and 256 inside one file |
| `icons/32x32.png`, `icons/128x128.png`, `icons/128x128@2x.png` | The names Tauri looks for |
| `icons/16x16.png` … `icons/512x512.png` | Everything else, for documentation and the website |

## When the Tauri shell arrives in phase 3

Copy `icons/` to `src-tauri/icons/` and point `tauri.conf.json` at it:

```json
"bundle": {
  "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.ico"]
}
```

A macOS `.icns` is not here because nothing in this repository can build one
yet. `npx tauri icon brand/icons/icon.png` regenerates the whole set, including
the `.icns`, from the 1024 source, and that is the easier path once the shell
exists.

## Regenerating by hand

The 16 px version is downscaled from 256 rather than rasterised directly,
because a browser rasterising the SVG straight to 16 px produces an empty
image. Every other size is rendered at its own size.

Below 24 px the three answer rows merge into a block. The clipboard and
checkmark silhouette still reads, which is what matters in a taskbar, but it is
worth knowing before anyone tries to add detail to the artwork.

## A note on the name

The SVG's embedded title and description say "OpenStage Assess", which is how
the file arrived and how the tool gets talked about. The product name settled
for the repository, the package and the file extension is OpenAssess. Both
spellings are deliberate as far as this folder is concerned; if they should be
made consistent, the two lines to change are `<title>` and `<desc>` in the SVG.
