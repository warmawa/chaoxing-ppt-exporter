#!/usr/bin/env python3
"""
生成扩展图标（16/32/48/128）。

不依赖 Pillow —— 直接用 zlib 手写 PNG，4x4 超采样做抗锯齿，
这样在没有第三方库的环境里也能一键生成图标。
"""

import os
import struct
import zlib

BLUE = (37, 99, 235)
WHITE = (255, 255, 255)
SS = 4  # 超采样倍数


def in_rounded_rect(x, y, r=0.24):
    """归一化坐标下的圆角矩形"""
    if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
        return False
    cx = min(max(x, r), 1.0 - r)
    cy = min(max(y, r), 1.0 - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def in_doc(x, y):
    """文档主体：矩形，右上角折角"""
    if not (0.27 <= x <= 0.73 and 0.18 <= y <= 0.63):
        return False
    # 右上角切掉的三角：斜边 (0.55,0.18) → (0.73,0.36)
    if x > 0.55 and y < 0.36:
        if (x - 0.55) / 0.18 > (y - 0.18) / 0.18:
            return False
    return True


def in_doc_line(x, y):
    """文档里的三条横线（用背景蓝画在白纸上）"""
    lines = [(0.30, 0.34, 0.66), (0.40, 0.34, 0.66), (0.50, 0.34, 0.58)]
    for ly, x0, x1 in lines:
        if x0 <= x <= x1 and abs(y - ly) <= 0.017:
            return True
    return False


def in_arrow(x, y):
    """向下的实心三角"""
    if not (0.34 <= x <= 0.66 and 0.66 <= y <= 0.83):
        return False
    t = (y - 0.66) / 0.17
    half = 0.16 * (1.0 - t)
    return abs(x - 0.5) <= half


def in_base(x, y):
    """底座横线"""
    return 0.32 <= x <= 0.68 and 0.855 <= y <= 0.905


def foreground(x, y):
    """返回 None / 'white' / 'blue'"""
    if in_doc(x, y):
        return "blue" if in_doc_line(x, y) else "white"
    if in_arrow(x, y) or in_base(x, y):
        return "white"
    return None


def render(size):
    rows = []
    inv = 1.0 / size
    for j in range(size):
        row = bytearray()
        for i in range(size):
            bg_cov = 0
            white_cov = 0
            blue_cov = 0
            for sy in range(SS):
                py = (j + (sy + 0.5) / SS) * inv
                for sx in range(SS):
                    px = (i + (sx + 0.5) / SS) * inv
                    if not in_rounded_rect(px, py):
                        continue
                    bg_cov += 1
                    kind = foreground(px, py)
                    if kind == "white":
                        white_cov += 1
                    elif kind == "blue":
                        blue_cov += 1
            n = SS * SS
            alpha = bg_cov / n
            if bg_cov:
                wr = white_cov / bg_cov
                br = blue_cov / bg_cov
                # 白纸 + 蓝线，剩下的部分露出背景蓝
                r = WHITE[0] * wr + BLUE[0] * br + BLUE[0] * (1 - wr - br)
                g = WHITE[1] * wr + BLUE[1] * br + BLUE[1] * (1 - wr - br)
                b = WHITE[2] * wr + BLUE[2] * br + BLUE[2] * (1 - wr - br)
            else:
                r = g = b = 0
            row += bytes((int(round(r)), int(round(g)), int(round(b)), int(round(alpha * 255))))
        rows.append(bytes(row))
    return rows


def write_png(path, rows, width, height):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "extension", "icons")
    out_dir = os.path.normpath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        rows = render(size)
        path = os.path.join(out_dir, f"icon-{size}.png")
        write_png(path, rows, size, size)
        print(f"生成 {path} ({size}x{size})")


if __name__ == "__main__":
    main()
