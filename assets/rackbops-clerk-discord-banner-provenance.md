# Rackbops Clerk Discord banner provenance

Created 2026-10-07 with the built-in image-generation tool, using the approved Clerk avatar as a style and palette reference.

## Source references

- [Clerk design specification](https://github.com/Rackbops/docket/blob/d615b411effa41193f3bec87fed4eab90eb04865/assets/rackbops-clerk-design-spec.md), Git blob `af2a01eaef5437f5351bf501844f42a0cb5e4de5`, read 2026-10-07.
- [Approved 512 px Clerk avatar](https://github.com/Rackbops/docket/blob/d615b411effa41193f3bec87fed4eab90eb04865/assets/rackbops-clerk-avatar-512.png), Git blob `aa975330c7d4981d441335e8516fb1c65913f713`, visually inspected before generation.
- [Exact generation prompt](rackbops-clerk-discord-banner-prompt.txt), preserved verbatim.

## Design and scope

The banner uses the Clerk's navy, brown leather, burgundy, warm cream and brass palette. The ledger, quill and key are grouped on the right; the left half remains quiet for the Discord avatar overlap. It contains no duplicate character or text. This asset package does not change Discord settings or application behavior.

## Master and export

- `rackbops-clerk-discord-banner-master.png`: unchanged generated 2110x745 RGB PNG, 1,850,333 bytes.
- `rackbops-clerk-discord-banner-680x240.png`: exact 680x240 (17:6) RGB PNG, 188,475 bytes, under the supplied 10 MB upload limit.

The prompt requested an ideal 1632x576 canvas. The image generator returned 2110x745, which is preserved as the master rather than mislabeled as an exact-ratio export.

The upload PNG was exported with ImageMagick:

```sh
magick rackbops-clerk-discord-banner-master.png \
  -filter Lanczos -resize '680x240^' \
  -gravity center -extent 680x240 -strip \
  rackbops-clerk-discord-banner-680x240.png
```

Only resizing, centered extent and metadata stripping were applied after generation; no artwork was drawn or composited during export.

## Verification

- The source avatar and final upload-size image were visually inspected.
- Ledger, quill and key are fully visible; the left-side avatar safe area stays clear.
- Both PNGs are opaque RGB images.
- Dimensions, byte sizes and SHA-256 digests are recorded in [asset-manifest.json](asset-manifest.json).
- Master SHA-256: `b2705921a8917556fad7c01a43eb0069e771e25771f9940d9c1061bf7e725d1c`.
- Export SHA-256: `5665036b72801b2610ebcadfc89a2fbaab8937985980c83b4fda76ac73a8d849`.
