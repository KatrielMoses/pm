#!/usr/bin/env python3
"""Verify the colour tokens in docs/ux/05-design-system.md against WCAG 2.x contrast minimums.

The design-system document is the single source: token values are read from its
token tables (rows of the form | `token` | `#RRGGBB` | `#RRGGBB` | ...) and the
required pairs from its "Required contrast pairs" table. Every pair is checked in
both the light and dark themes.

Usage:  python3 docs/ux/tools/check_contrast.py [path/to/05-design-system.md]
Exit status is 0 when every pair passes, 1 otherwise.
"""
import itertools
import pathlib
import re
import sys

DOC = pathlib.Path(__file__).resolve().parent.parent / "05-design-system.md"
TOKEN_ROW = re.compile(r"^\|\s*`(color\.[a-z0-9.\-]+)`\s*\|\s*`(#[0-9A-Fa-f]{6})`\s*\|\s*`(#[0-9A-Fa-f]{6})`\s*\|")
PAIR_ROW = re.compile(r"^\|\s*`(color\.[a-z0-9.\-]+)`\s*\|\s*`(color\.[a-z0-9.\-]+)`\s*\|\s*([0-9.]+)\s*\|")


def luminance(hex_colour):
    channels = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def ratio(a, b):
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def main():
    doc = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DOC
    tokens, pairs = {}, []
    for line in doc.read_text(encoding="utf-8").splitlines():
        if m := TOKEN_ROW.match(line):
            if m.group(1) in tokens:
                print(f"DUPLICATE token definition: {m.group(1)}")
                return 1
            tokens[m.group(1)] = {"light": m.group(2), "dark": m.group(3)}
        elif m := PAIR_ROW.match(line):
            pairs.append((m.group(1), m.group(2), float(m.group(3))))

    if not tokens or not pairs:
        print("No tokens or pairs found; check the document format.")
        return 1

    failures = 0
    for fg, bg, minimum in pairs:
        for name in (fg, bg):
            if name not in tokens:
                print(f"UNKNOWN token in pair table: {name}")
                failures += 1
        if fg not in tokens or bg not in tokens:
            continue
        for theme in ("light", "dark"):
            r = ratio(tokens[fg][theme], tokens[bg][theme])
            ok = r >= minimum
            failures += not ok
            if not ok or "-v" in sys.argv:
                print(f"{'PASS' if ok else 'FAIL'}  {theme:5}  {fg} on {bg}: {r:.2f}:1 (min {minimum})")

    # DS-41: for any brand colour, the better of black or white glyphs must reach 4.5:1.
    worst = min(
        max(ratio(c, "#FFFFFF"), ratio(c, "#000000"))
        for c in ("#%02X%02X%02X" % rgb for rgb in itertools.product(range(0, 256, 3), repeat=3))
    )
    brand_ok = worst >= 4.5
    failures += not brand_ok

    print(f"{len(tokens)} tokens, {len(pairs)} pairs x 2 themes = {len(pairs) * 2} checks; "
          f"brand-glyph worst case {worst:.2f}:1 ({'PASS' if brand_ok else 'FAIL'})")
    print("All contrast checks passed." if failures == 0 else f"{failures} failure(s).")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
