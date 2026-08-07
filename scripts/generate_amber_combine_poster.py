#!/usr/bin/env python3
"""Generate the approved Amber Combine social poster from canonical repository assets."""

from __future__ import annotations

import argparse
import io
import urllib.request
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

DEFAULT_SOURCE = (
    "https://raw.githubusercontent.com/onedayonemasterpiece/kdg80/main/"
    "site/public/generated/special/amber-combine-jewelry-production.webp"
)
DEFAULT_MEDALLION = (
    "https://raw.githubusercontent.com/onedayonemasterpiece/events-bot-new/main/"
    "site/public/assets/festivals/kgd80-80-stories.png"
)

WIDTH = 1080
HEIGHT = 1350
PHOTO_BOTTOM = 800
STRIP_TOP = 710

FONT_REGULAR = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
FONT_BOLD = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
FONT_SERIF_ITALIC = Path("/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf")


def load_image(location: str) -> Image.Image:
    if location.startswith(("http://", "https://")):
        request = urllib.request.Request(
            location,
            headers={"User-Agent": "social-communications-poster/1.0"},
        )
        with urllib.request.urlopen(request, timeout=45) as response:
            payload = response.read()
        return Image.open(io.BytesIO(payload)).convert("RGBA")
    return Image.open(Path(location)).convert("RGBA")


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    if not path.is_file():
        raise FileNotFoundError(f"Required font is absent: {path}")
    return ImageFont.truetype(str(path), size=size)


def draw_text_with_shadow(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    text_font: ImageFont.FreeTypeFont,
    fill: str,
    *,
    shadow_alpha: int = 140,
    shadow_offset: tuple[int, int] = (2, 3),
) -> None:
    x, y = xy
    sx, sy = shadow_offset
    draw.text((x + sx, y + sy), text, font=text_font, fill=(0, 0, 0, shadow_alpha))
    draw.text((x, y), text, font=text_font, fill=fill)


def gradient_rectangle(
    canvas: Image.Image,
    box: tuple[int, int, int, int],
    top: tuple[int, int, int],
    bottom: tuple[int, int, int],
) -> None:
    left, upper, right, lower = box
    height = max(1, lower - upper)
    gradient = Image.new("RGB", (1, height))
    pixels = gradient.load()
    for y in range(height):
        ratio = y / max(1, height - 1)
        pixels[0, y] = tuple(
            round(top[index] * (1 - ratio) + bottom[index] * ratio)
            for index in range(3)
        )
    gradient = gradient.resize((right - left, height))
    canvas.paste(gradient, (left, upper))


def draw_facets(layer: Image.Image) -> None:
    draw = ImageDraw.Draw(layer, "RGBA")
    facets: Iterable[tuple[list[tuple[int, int]], tuple[int, int, int, int]]] = (
        ([(0, 800), (390, 800), (245, 1040), (0, 1120)], (255, 236, 177, 55)),
        ([(390, 800), (690, 800), (620, 1030), (245, 1040)], (255, 192, 62, 40)),
        ([(690, 800), (1080, 800), (1080, 990), (810, 1080), (620, 1030)], (255, 145, 25, 44)),
        ([(0, 1120), (245, 1040), (445, 1210), (250, 1350), (0, 1350)], (255, 244, 205, 45)),
        ([(245, 1040), (620, 1030), (640, 1350), (250, 1350), (445, 1210)], (240, 141, 20, 33)),
        ([(620, 1030), (810, 1080), (1080, 990), (1080, 1350), (640, 1350)], (210, 92, 15, 37)),
        ([(0, 800), (140, 800), (0, 930)], (255, 249, 216, 38)),
        ([(940, 800), (1080, 800), (1080, 930)], (255, 235, 194, 30)),
    )
    for points, fill in facets:
        draw.polygon(points, fill=fill)
    draw.line([(0, 800), (1080, 800)], fill=(255, 216, 132, 110), width=2)


def draw_pill(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    size: tuple[int, int],
    label: str,
    label_font: ImageFont.FreeTypeFont,
) -> None:
    x, y = xy
    width, height = size
    outline = (204, 74, 37, 255)
    fill = (255, 210, 112, 145)
    draw.rounded_rectangle(
        (x, y, x + width, y + height),
        radius=height // 2,
        fill=fill,
        outline=outline,
        width=2,
    )
    bbox = draw.textbbox((0, 0), label, font=label_font)
    tx = x + (width - (bbox[2] - bbox[0])) // 2
    ty = y + (height - (bbox[3] - bbox[1])) // 2 - bbox[1]
    draw.text((tx, ty), label, font=label_font, fill=(105, 42, 18, 255))


def draw_star(draw: ImageDraw.ImageDraw, center: tuple[int, int], radius: int) -> None:
    cx, cy = center
    points = [
        (cx, cy - radius),
        (cx + radius // 3, cy - radius // 3),
        (cx + radius, cy),
        (cx + radius // 3, cy + radius // 3),
        (cx, cy + radius),
        (cx - radius // 3, cy + radius // 3),
        (cx - radius, cy),
        (cx - radius // 3, cy - radius // 3),
    ]
    draw.polygon(points, fill=(255, 245, 215, 205))


def generate(source_location: str, medallion_location: str, output: Path) -> None:
    source = load_image(source_location)
    medallion = load_image(medallion_location)

    canvas = Image.new("RGB", (WIDTH, HEIGHT), "#F4A736")

    # Preserve the canonical excursion photo; only crop it to the approved 4:5 composition.
    photo = ImageOps.fit(
        source.convert("RGB"),
        (WIDTH, PHOTO_BOTTOM),
        method=Image.Resampling.LANCZOS,
        centering=(0.52, 0.46),
    )
    canvas.paste(photo, (0, 0))

    # Gentle local contrast treatment without repainting the source photograph.
    photo_treatment = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    treatment_draw = ImageDraw.Draw(photo_treatment, "RGBA")
    for x in range(620):
        alpha = round(55 * (1 - x / 620))
        treatment_draw.line([(x, 0), (x, 330)], fill=(0, 0, 0, alpha))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), photo_treatment)

    draw = ImageDraw.Draw(canvas, "RGBA")
    date_font = font(FONT_BOLD, 68)
    day_font = font(FONT_REGULAR, 52)
    strip_font = font(FONT_BOLD, 30)
    kicker_font = font(FONT_SERIF_ITALIC, 29)
    title_font = font(FONT_BOLD, 70)
    place_font = font(FONT_BOLD, 29)
    pill_font = font(FONT_REGULAR, 18)

    draw_text_with_shadow(draw, (66, 62), "11 АВГУСТА,", date_font, "#FFF6EB")
    draw_text_with_shadow(draw, (66, 140), "ВТОРНИК · 11:00", day_font, "#FFF6EB")

    # Use the canonical round medallion unchanged, preserving its proportions.
    medallion_size = 245
    medallion = ImageOps.contain(
        medallion,
        (medallion_size, medallion_size),
        method=Image.Resampling.LANCZOS,
    )
    shadow = Image.new("RGBA", (medallion_size + 30, medallion_size + 30), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow, "RGBA")
    shadow_draw.ellipse((15, 15, medallion_size + 15, medallion_size + 15), fill=(0, 0, 0, 115))
    shadow = shadow.filter(ImageFilter.GaussianBlur(9))
    canvas.alpha_composite(shadow, (790, 26))
    canvas.alpha_composite(medallion, (805, 36))

    draw.rectangle((0, STRIP_TOP, WIDTH, PHOTO_BOTTOM), fill=(43, 25, 24, 200))
    strip = "НЕ МУЗЕЙ — ДЕЙСТВУЮЩЕЕ ПРОИЗВОДСТВО"
    strip_bbox = draw.textbbox((0, 0), strip, font=strip_font)
    strip_x = (WIDTH - (strip_bbox[2] - strip_bbox[0])) // 2
    strip_y = STRIP_TOP + (PHOTO_BOTTOM - STRIP_TOP - (strip_bbox[3] - strip_bbox[1])) // 2 - strip_bbox[1]
    draw.text((strip_x, strip_y), strip, font=strip_font, fill=(255, 239, 213, 255))

    bottom = Image.new("RGB", (WIDTH, HEIGHT - PHOTO_BOTTOM))
    gradient_rectangle(bottom, (0, 0, WIDTH, HEIGHT - PHOTO_BOTTOM), (255, 209, 113), (245, 157, 35))
    canvas.alpha_composite(bottom.convert("RGBA"), (0, PHOTO_BOTTOM))
    facets = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw_facets(facets)
    canvas = Image.alpha_composite(canvas, facets)
    draw = ImageDraw.Draw(canvas, "RGBA")

    dark = (97, 32, 13, 255)
    draw.text((66, 842), "СПЕЦИАЛЬНАЯ ЭКСКУРСИЯ", font=kicker_font, fill=dark)

    title_lines = ("ЮВЕЛИРНОЕ", "ПРОИЗВОДСТВО", "ЯНТАРНОГО", "КОМБИНАТА")
    y = 897
    for line in title_lines:
        draw.text((66, y), line, font=title_font, fill=dark, stroke_width=1, stroke_fill=dark)
        y += 79

    draw.text((68, 1220), "ПОСЁЛОК ЯНТАРНЫЙ", font=place_font, fill=dark)
    draw_star(draw, (952, 1196), 28)

    pill_y = 1281
    draw_pill(draw, (66, pill_y), (190, 47), "БЕСПЛАТНО", pill_font)
    draw_pill(draw, (270, pill_y), (72, 47), "18+", pill_font)
    draw_pill(draw, (356, pill_y), (258, 47), "ПО РЕГИСТРАЦИИ", pill_font)
    draw_pill(draw, (628, pill_y), (344, 47), "РОЗЫГРЫШ 9 АВГУСТА", pill_font)

    output.parent.mkdir(parents=True, exist_ok=True)
    final = canvas.convert("RGB")
    final.save(output, format="PNG", optimize=True, compress_level=9)
    print(f"POSTER={output} SIZE={final.width}x{final.height} BYTES={output.stat().st_size}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--source", default=DEFAULT_SOURCE)
    parser.add_argument("--medallion", default=DEFAULT_MEDALLION)
    args = parser.parse_args()
    generate(args.source, args.medallion, args.output)


if __name__ == "__main__":
    main()
