"""Rebuild the bundled wave-frame TrueType font with Python's standard library.

The hundred two-digit ligatures sample the Desktop notch.css curve. Runtime font size 20
maps the 1,250-unit advance to 25pt and the 920-unit ascender to 18.4pt.
Only asset authoring uses this file; building/running iOS needs no Python.
"""
import struct, math
from pathlib import Path
U = lambda *x: struct.pack('>' + 'H' * len(x), *x)
S = lambda *x: struct.pack('>' + 'h' * len(x), *x)
L = lambda *x: struct.pack('>' + 'I' * len(x), *x)

def curve(t):
    lo, hi = (0.0, 1.0)
    for _ in range(40):
        a = (lo + hi) / 2
        x = 3 * (1 - a) ** 2 * a * 0.42 + 3 * (1 - a) * a * a * 0.58 + a ** 3
        if x < t:
            lo = a
        else:
            hi = a
    a = (lo + hi) / 2
    return 3 * (1 - a) * a * a + a ** 3
heights = [7, 13, 9, 15, 6]
delays = [0.2, 0.55, 0.85, 0.35, 0.7]

def glyph(frame):
    pts = []
    flags = []
    for i, h in enumerate(heights):
        t = (frame / 100 + delays[i] / 1.05) % 1
        t = t * 2 if t < 0.5 else (1 - t) * 2
        h = round(h * 50 * 1.15 * (1 - 0.6 * curve(t)))
        x = i * 275
        y = round(460 - h / 2)
        r = 75
        w = 150
        shape = [(x + r, y + h, 1), (x + w, y + h, 0), (x + w, y + h - r, 1), (x + w, y + r, 1), (x + w, y, 0), (x + r, y, 1), (x, y, 0), (x, y + r, 1), (x, y + h - r, 1), (x, y + h, 0)]
        pts.extend(((a, b) for a, b, _ in shape))
        flags.extend((c for _, _, c in shape))
    out = S(5, 0, 0, 1250, 920) + U(9, 19, 29, 39, 49) + U(0) + bytes(flags)
    for dim in [0, 1]:
        prev = 0
        for p in pts:
            out += S(p[dim] - prev)
            prev = p[dim]
    return out + b'\x00' * (len(out) % 2)
glyphs = [b''] + [glyph(i * 10) for i in range(10)] + [glyph(i) for i in range(100)]
loca = [0]
for g in glyphs:
    loca.append(loca[-1] + len(g))
n = len(glyphs)
tables = {}
tables['glyf'] = b''.join(glyphs)
tables['loca'] = L(*loca)
tables['head'] = L(65536, 65536, 0, 1594834165) + U(3, 1000) + b'\x00' * 16 + S(0, 0, 1250, 920) + U(0, 8) + S(2, 1, 0)
tables['hhea'] = L(65536) + S(920, 0, 0) + U(1250) + S(0, 0, 1250, 1, 0, 0) + S(0, 0, 0, 0, 0) + U(n)
tables['maxp'] = L(65536) + U(n, 50, 5, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0)
tables['hmtx'] = b''.join((U(1250) + S(0) for _ in glyphs))
fmt4 = U(4, 32, 0, 4, 4, 1, 0) + U(57, 65535) + U(0) + U(48, 65535) + S(-47, 1) + U(0, 0)
tables['cmap'] = U(0, 1) + U(3, 1) + L(12) + fmt4
# Required ligatures combine each hundredths pair into one 25pt wave frame.
# Decimal punctuation separates the fractional pair from preceding clock fields.
sets = []
for tens in range(10):
    ligatures = [U(11 + tens * 10 + ones, 2, 1 + ones) for ones in range(10)]
    sets.append(U(10) + U(*(22 + 6 * i for i in range(10))) + b''.join(ligatures))
coverage = U(1, 10, *range(1, 11))
subtable = U(1, 26, 10) + U(*(50 + 82 * i for i in range(10))) + coverage + b''.join(sets)
lookup_list = U(1, 4) + U(4, 0, 1, 8) + subtable
script_list = U(1) + b'DFLT' + U(8) + U(4, 0) + U(0, 65535, 1, 0)
feature_list = U(1) + b'rlig' + U(8) + U(0, 1, 0)
tables['GSUB'] = L(65536) + U(10, 10 + len(script_list), 10 + len(script_list) + len(feature_list)) + script_list + feature_list + lookup_list
names = {1: 'TokenMonitorActivityWaveSmooth', 2: 'Regular', 3: 'TokenMonitorActivityWaveSmooth-2', 4: 'Token Monitor Activity Wave', 6: 'TokenMonitorActivityWaveSmooth'}
records = []
data = b''
for key, value in names.items():
    b = value.encode('utf-16-be')
    records.append(U(3, 1, 1033, key, len(b), len(data)))
    data += b
tables['name'] = U(0, len(records), 6 + 12 * len(records)) + b''.join(records) + data
tables['post'] = L(196608, 0) + S(0, 0) + L(0, 0, 0, 0, 0)
tables['OS/2'] = U(0) + S(1250) + U(400, 5, 0) + S(650, 600, 0, 75, 650, 600, 0, 350, 50, 250, 0) + bytes(10) + L(1, 0, 0, 0) + b'TM  ' + U(64, 48, 57) + S(920, 0, 0) + U(920, 0)

def checksum(b):
    b += b'\x00' * (-len(b) % 4)
    return sum(struct.unpack('>' + 'I' * (len(b) // 4), b)) & 4294967295
keys = sorted(tables)
power = 2 ** int(math.log2(len(keys)))
offset = 12 + 16 * len(keys)
header = L(65536) + U(len(keys), power * 16, int(math.log2(power)), len(keys) * 16 - power * 16)
records = []
body = b''
head_offset = None
for key in keys:
    b = tables[key]
    records.append(key.encode() + L(checksum(b), offset, len(b)))
    if key == 'head':
        head_offset = offset
    padded = b + b'\x00' * (-len(b) % 4)
    body += padded
    offset += len(padded)
font = bytearray(header + b''.join(records) + body)
struct.pack_into('>I', font, head_offset + 8, 2981146554 - checksum(font) & 4294967295)
path = Path(__file__).with_name('TokenMonitorActivityWave.ttf')
path.write_bytes(font)
print(path, len(font))
