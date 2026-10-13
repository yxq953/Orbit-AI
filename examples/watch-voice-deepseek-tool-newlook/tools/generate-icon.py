"""Export the simple Orbit AI mark at the watch launcher's original 96px size.

The editable design lives in src/common/orbit-ai.svg. Uses existing Pillow;
no package installation or external image-generation service is needed.
"""
from math import cos, sin, radians, hypot
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SCALE = 8
SIZE = 96
surface = Image.new('RGBA', (SIZE * SCALE, SIZE * SCALE))
pixels = surface.load()
for y in range(SIZE * SCALE):
    for x in range(SIZE * SCALE):
        distance = min(1, hypot(x / SCALE - SIZE * .32, y / SCALE - SIZE * .22) / (SIZE * .86))
        top, bottom = (25, 52, 47), (8, 15, 20)
        pixels[x, y] = tuple(round(a + (b - a) * distance) for a, b in zip(top, bottom)) + (255,)
mask = Image.new('L', surface.size)
ImageDraw.Draw(mask).ellipse((SCALE, SCALE, 95 * SCALE, 95 * SCALE), fill=255)
surface.putalpha(mask)
draw = ImageDraw.Draw(surface)
draw.ellipse((2 * SCALE, 2 * SCALE, 94 * SCALE, 94 * SCALE), outline='#29483f', width=SCALE)
angle = radians(-32)
def orbit_point(theta):
    x, y = 37 * cos(theta), 29 * sin(theta)
    return ((48 + x * cos(angle) - y * sin(angle)) * SCALE,
            (48 + x * sin(angle) + y * cos(angle)) * SCALE)

for i in range(720):
    start, end = orbit_point(radians(i / 2)), orbit_point(radians((i + 1) / 2))
    x, y = start[0] / SCALE, start[1] / SCALE
    blend = max(0, min(1, ((x - 10) * 73 + (y - 12) * 69) / (73 ** 2 + 69 ** 2)))
    color = tuple(round(a + (b - a) * blend) for a, b in zip((158, 242, 209), (79, 155, 179)))
    draw.line((start, end), fill=color, width=3 * SCALE)

for x, height in ((28, 12), (37, 24), (46, 36), (55, 24), (64, 12)):
    draw.rounded_rectangle((x * SCALE, (48 - height / 2) * SCALE,
                            (x + 5) * SCALE, (48 + height / 2) * SCALE),
                           radius=2.5 * SCALE, fill='#9ef2d1')
cx, cy = orbit_point(0)
for radius, color in ((6, '#0e191e'), (4, '#f5aa96')):
    draw.ellipse((cx - radius * SCALE, cy - radius * SCALE,
                  cx + radius * SCALE, cy + radius * SCALE), fill=color)

target = ROOT / 'src/common/orbit-ai.png'
surface.resize((SIZE, SIZE), Image.Resampling.LANCZOS).save(target, optimize=True)
print(f'Generated {target} (96 x 96, RGBA)')
