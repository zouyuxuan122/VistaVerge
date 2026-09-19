#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 NSIS 定制安装页的品牌位图（header 150x57 / sidebar 164x314）。

为什么单独写脚本：NSIS Modern UI 只吃 BMP，且尺寸固定（header 150x57、
sidebar 164x314）。用 PIL 现画，产物可复现、可审查，不引入外部素材授权问题。

产物（相对 desktop/src-tauri/）：
  installer/header.bmp   150x57  安装页顶部横幅
  installer/sidebar.bmp  164x314 欢迎页/完成页左侧竖图

用法：python desktop/scripts/make-installer-art.py
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# 品牌色（与 src/styles/app.css 的 --accent/--accent-warm 对齐）
BG_TOP = (10, 12, 17)      # #0a0c11
BG_BOTTOM = (22, 28, 44)   # #161c2c
ACCENT = (142, 162, 255)   # #8ea2ff
ACCENT_WARM = (232, 185, 138)  # #e8b98a
TEXT = (235, 239, 248)

ROOT = Path(__file__).resolve().parent.parent  # desktop/
OUT_DIR = ROOT / "src-tauri" / "installer"

FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_REG = "C:/Windows/Fonts/msyh.ttc"
FONT_LATIN_BOLD = "C:/Windows/Fonts/arialbd.ttf"


def load_font(path: str, size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def vertical_gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    w, h = size
    img = Image.new("RGB", size)
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        row = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = row
    return img


def draw_monogram(draw: ImageDraw.ImageDraw, cx: int, cy: int, r: int) -> None:
    """VistaVerge 单色徽记：圆环 + VV。"""
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=ACCENT, width=max(2, r // 12))
    font = load_font(FONT_LATIN_BOLD, int(r * 1.05))
    # 两个 V 之间留字距，避免挤在一起被读成 "W"
    text = "V V"
    box = draw.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    draw.text((cx - tw / 2 - box[0], cy - th / 2 - box[1]), text, font=font, fill=ACCENT)


def make_header() -> None:
    w, h = 150, 57
    img = vertical_gradient((w, h), BG_TOP, BG_BOTTOM)
    d = ImageDraw.Draw(img)
    # 右侧暖色斜带，增加层次
    d.polygon([(w - 34, 0), (w, 0), (w, h), (w - 58, h)], fill=(30, 36, 56))
    draw_monogram(d, 26, h // 2, 15)
    name_font = load_font(FONT_LATIN_BOLD, 15)
    d.text((50, 10), "VistaVerge", font=name_font, fill=TEXT)
    tag_font = load_font(FONT_REG, 10)
    d.text((50, 30), "AI 伙伴 · 桌面", font=tag_font, fill=ACCENT_WARM)
    d.line([(0, h - 2), (w, h - 2)], fill=ACCENT, width=2)
    img.save(OUT_DIR / "header.bmp", format="BMP")


def make_sidebar() -> None:
    w, h = 164, 314
    img = vertical_gradient((w, h), BG_TOP, BG_BOTTOM)
    d = ImageDraw.Draw(img)
    # 顶部装饰斜带
    d.polygon([(0, 0), (w, 0), (w, 34), (0, 58)], fill=(28, 34, 52))
    # 底部品牌色带
    d.rectangle([0, h - 46, w, h], fill=(16, 20, 32))
    d.line([(0, h - 46), (w, h - 46)], fill=ACCENT, width=2)

    draw_monogram(d, w // 2, 78, 30)

    title_font = load_font(FONT_LATIN_BOLD, 20)
    title = "VistaVerge"
    box = d.textbbox((0, 0), title, font=title_font)
    d.text(((w - (box[2] - box[0])) / 2 - box[0], 124), title, font=title_font, fill=TEXT)

    sub_font = load_font(FONT_REG, 13)
    for i, line in enumerate(["你的桌面 AI 伙伴", "本地记忆 · 语音陪伴"]):
        box = d.textbbox((0, 0), line, font=sub_font)
        d.text(((w - (box[2] - box[0])) / 2 - box[0], 158 + i * 22), line, font=sub_font, fill=ACCENT_WARM)

    # 中间点缀：三点
    for i in range(3):
        x = w // 2 - 18 + i * 18
        d.ellipse([x - 3, 214, x + 3, 220], fill=ACCENT if i == 1 else (70, 82, 118))

    ver_font = load_font(FONT_LATIN_BOLD, 12)
    ver = "0.1.0-beta.2"
    box = d.textbbox((0, 0), ver, font=ver_font)
    d.text(((w - (box[2] - box[0])) / 2 - box[0], h - 32), ver, font=ver_font, fill=TEXT)
    img.save(OUT_DIR / "sidebar.bmp", format="BMP")


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    make_header()
    make_sidebar()
    for name in ("header.bmp", "sidebar.bmp"):
        p = OUT_DIR / name
        with Image.open(p) as im:
            print(f"{p} {im.size} {im.mode} {p.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
