#!/usr/bin/env python3
"""Render X Monitor's extension icons without any image dependencies.

The mark is a rounded gradient tile with a white pulse line. Everything is
supersampled 4x and box-filtered for clean edges.
"""

import math
import os
import struct
import zlib

SIZES = (16, 32, 48, 128)
SS = 4


def clamp(value, low=0.0, high=1.0):
    return max(low, min(high, value))


def lerp(a, b, t):
    return a + (b - a) * t


def rgb(hex_value):
    value = hex_value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


VIOLET = rgb("#8b5cf6")
INDIGO = rgb("#6366f1")
CYAN = rgb("#22d3ee")


def gradient(nx, ny):
    t = clamp((nx * 0.58 + ny * 0.62) * 1.15)
    if t < 0.5:
        local = t / 0.5
        return tuple(lerp(VIOLET[i], INDIGO[i], local) for i in range(3))
    local = (t - 0.5) / 0.5
    return tuple(lerp(INDIGO[i], CYAN[i], local) for i in range(3))


def rounded_rect_distance(px, py, size, radius):
    half = size / 2.0
    cx = abs(px - half) - (half - radius)
    cy = abs(py - half) - (half - radius)
    outside = math.hypot(max(cx, 0.0), max(cy, 0.0))
    inside = min(max(cx, cy), 0.0)
    return outside + inside - radius


def segment_distance(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    length_sq = vx * vx + vy * vy
    t = clamp((wx * vx + wy * vy) / length_sq) if length_sq else 0.0
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


PULSE = [
    (0.145, 0.645),
    (0.335, 0.395),
    (0.475, 0.560),
    (0.670, 0.230),
    (0.855, 0.440),
]
DOT = (0.855, 0.690)


def render(size):
    hi = size * SS
    pixels = [0.0] * (hi * hi * 4)
    radius = hi * 0.225
    gradient_span = hi * 0.28

    def points(scale):
        pts = [(x * scale, y * scale) for x, y in PULSE]
        dot = (DOT[0] * scale, DOT[1] * scale)
        return pts, dot

    points_hi, dot_hi = points(hi)
    stroke = hi * 0.082
    dot_radius = hi * 0.083
    shadow_offset = hi * 0.012

    for y in range(hi):
        for x in range(hi):
            px = x + 0.5
            py = y + 0.5

            if rounded_rect_distance(px, py, hi, radius) > 0:
                continue

            nx = px / hi
            ny = py / hi
            base = gradient(nx, ny)

            # Soft radial highlight in the upper-left.
            highlight = clamp(1.0 - math.hypot(nx - 0.28, ny - 0.18) / 0.55)
            highlight = highlight ** 2 * 0.16
            for i in range(3):
                base = base[:i] + (lerp(base[i], 255.0, highlight),) + base[i + 1:]

            # Subtle darkening toward the bottom-right for depth.
            shade = clamp((nx + ny - 0.8) * 0.22, 0.0, 0.12)
            base = tuple(channel * (1.0 - shade) for channel in base)

            color = base
            alpha = 1.0

            line_dist = min(
                segment_distance(px, py, *points_hi[i], *points_hi[i + 1])
                for i in range(len(points_hi) - 1)
            )
            dot_dist = math.hypot(px - dot_hi[0], py - dot_hi[1])

            shadow_dist = min(
                segment_distance(px, py - shadow_offset, *points_hi[i], *points_hi[i + 1])
                for i in range(len(points_hi) - 1)
            )
            shadow_hit = shadow_dist <= stroke / 2 + hi * 0.02
            dot_shadow = math.hypot(px - dot_hi[0], py - dot_hi[1] + shadow_offset) <= dot_radius + hi * 0.02
            if shadow_hit or dot_shadow:
                color = tuple(channel * 0.72 for channel in color)

            if line_dist <= stroke / 2:
                color = (255.0, 255.0, 255.0)
            if dot_dist <= dot_radius:
                color = (255.0, 255.0, 255.0)

            offset = (y * hi + x) * 4
            pixels[offset] = color[0]
            pixels[offset + 1] = color[1]
            pixels[offset + 2] = color[2]
            pixels[offset + 3] = alpha * 255.0

    # Box downsample with premultiplied alpha.
    out = bytearray(size * size * 4)
    block = SS * SS
    for y in range(size):
        for x in range(size):
            sr = sg = sb = sa = 0.0
            for dy in range(SS):
                for dx in range(SS):
                    offset = (((y * SS + dy) * hi) + (x * SS + dx)) * 4
                    a = pixels[offset + 3] / 255.0
                    sr += pixels[offset] * a
                    sg += pixels[offset + 1] * a
                    sb += pixels[offset + 2] * a
                    sa += a
            alpha = sa / block
            if sa > 0:
                r = sr / sa
                g = sg / sa
                b = sb / sa
            else:
                r = g = b = 0.0
            offset = (y * size + x) * 4
            out[offset] = int(clamp(r / 255.0) * 255 + 0.5)
            out[offset + 1] = int(clamp(g / 255.0) * 255 + 0.5)
            out[offset + 2] = int(clamp(b / 255.0) * 255 + 0.5)
            out[offset + 3] = int(alpha * 255 + 0.5)
    return bytes(out)


def write_png(path, size, rgba):
    rows = []
    stride = size * 4
    for y in range(size):
        rows.append(b"\x00" + rgba[y * stride:(y + 1) * stride])
    raw = b"".join(rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as handle:
        handle.write(png)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in SIZES:
        path = os.path.join(out_dir, f"icon{size}.png")
        write_png(path, size, render(size))
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
