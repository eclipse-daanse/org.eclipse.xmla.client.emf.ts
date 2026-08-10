# A vendored copy of `@emfts/uimodel-composer`

## Why it is here

The package is not published. `npm view @emfts/uimodel-composer` answers 404,
and it is what renders a UI that is itself an Ecore model — the thing this
project's explorer is built around. So it is copied in rather than depended on.

Source: `emf.ts.ui-snapshot`, version `0.0.1-next.1`, EPL-2.0 like everything
else here. `@emfts/vue-registry`, which it needs, *is* on npm and is a normal
dependency.

## What was removed, and why

Two of its composers pull in charting and mapping libraries that this project
has no use for and that together outweigh everything else in it:

| Removed | Pulled in |
|---|---|
| `src/composers/VegaViewComposer.vue` | `vega`, `vega-lite` |
| `src/composers/MapViewComposer.vue` | `ol` (OpenLayers) |
| `src/generated/vega/`, `src/generated/maps/` | the models behind those two |
| `model/uimodel-vega.*`, `model/uimodel-maps.*` | — |

Measured before cutting: exactly four files in the whole tree referred to `ol`
or `vega`, so the removal is a clean cut rather than an unpicking. Two edits
follow from it — `src/index.ts` no longer re-exports them, and
`UIModelComposer.vue` no longer registers `VegaView` and `MapView` as composer
keys. Leaving the keys registered with nothing behind them would have made a
`VegaView` in a UIModel render as blank instead of saying it is unsupported.

`useMapSelection.ts` is kept: it is a composable with no import of `ol`, and its
comments name the composer that used to call it.

## Keeping it honest

`npm run check:vendor` compares this tree against the snapshot, file by file,
and fails on any difference other than the removals and the two edits listed
above. Point it at a checkout with `UIMODEL_SNAPSHOT=/path/to/emf.ts.ui-snapshot`.

If the package is ever published, this whole directory should go and the
dependency should be a normal one.
