"""Auto-crop the AI-generated TradeAPP logo to its content bounding box
(with a small breathing-room margin) so it displays crisply at small
sizes in the app header, tab bar, and PDF chip.

Input:  /app/frontend/assets/tradeapp-logo.png (1024×1024 square with
        heavy black padding — the glyphs occupy ~1/3 of the canvas)
Output: /app/frontend/assets/images/logo-tradeapp.png (tight crop)
"""
from pathlib import Path
from PIL import Image, ImageOps


def main() -> None:
    src_path = Path("/app/frontend/assets/tradeapp-logo.png")
    dst_path = Path("/app/frontend/assets/images/logo-tradeapp.png")
    img = Image.open(src_path).convert("RGB")
    w, h = img.size

    # Find the tightest bounding box around any non-black pixel.
    # We treat pixels with any RGB channel above threshold as "content".
    px = img.load()
    threshold = 40
    min_x, min_y, max_x, max_y = w, h, 0, 0
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if r > threshold or g > threshold or b > threshold:
                if x < min_x: min_x = x
                if y < min_y: min_y = y
                if x > max_x: max_x = x
                if y > max_y: max_y = y

    if max_x <= min_x or max_y <= min_y:
        print("no content found")
        return

    # Add breathing room — 10% margin on each side.
    margin_x = int((max_x - min_x) * 0.10)
    margin_y = int((max_y - min_y) * 0.35)
    left   = max(0, min_x - margin_x)
    top    = max(0, min_y - margin_y)
    right  = min(w, max_x + margin_x + 1)
    bottom = min(h, max_y + margin_y + 1)
    cropped = img.crop((left, top, right, bottom))

    cw, ch = cropped.size
    print(f"Original: {w}x{h}  ->  Cropped: {cw}x{ch}  (bbox {left},{top}-{right},{bottom})")

    # Also save the cropped version back to the source path so any code
    # referencing the raw asset picks up the new dimensions too.
    cropped.save(dst_path, "PNG", optimize=True)
    cropped.save(src_path, "PNG", optimize=True)
    print(f"OK: wrote {dst_path} ({dst_path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
