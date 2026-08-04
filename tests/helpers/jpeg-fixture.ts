/**
 * Minimal JPEG builder for Module 4 tests.
 *
 * Writes a real EXIF APP1 segment — TIFF header, IFD0, an Exif sub-IFD and an
 * optional GPS IFD — so the tests parse genuine bytes with exifr rather than
 * asserting against a hand-written object. A mocked parser would pass while the
 * real one failed on the byte layout, which is the only part worth testing.
 *
 * Big-endian ("MM") throughout, which keeps the offsets readable.
 */

const TYPE_BYTE = 1;
const TYPE_ASCII = 2;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Inline 4-byte payload, or bytes to be appended after the IFD. */
  inline?: number;
  data?: number[];
}

const ascii = (tag: number, value: string): Entry => {
  const bytes = [...new TextEncoder().encode(value), 0];
  return { tag, type: TYPE_ASCII, count: bytes.length, data: bytes };
};

/** Degrees/minutes/seconds as three RATIONALs, the form EXIF requires for GPS. */
const dms = (tag: number, degrees: number, minutes: number, seconds: number): Entry => {
  const out: number[] = [];
  const push = (num: number, den: number) => {
    out.push((num >>> 24) & 0xff, (num >>> 16) & 0xff, (num >>> 8) & 0xff, num & 0xff);
    out.push((den >>> 24) & 0xff, (den >>> 16) & 0xff, (den >>> 8) & 0xff, den & 0xff);
  };
  push(degrees, 1);
  push(minutes, 1);
  // Thousandths, so fractional seconds survive as an integer numerator.
  push(Math.round(seconds * 1000), 1000);
  return { tag, type: TYPE_RATIONAL, count: 3, data: out };
};

const rational = (tag: number, num: number, den: number): Entry => ({
  tag,
  type: TYPE_RATIONAL,
  count: 1,
  data: [
    (num >>> 24) & 0xff, (num >>> 16) & 0xff, (num >>> 8) & 0xff, num & 0xff,
    (den >>> 24) & 0xff, (den >>> 16) & 0xff, (den >>> 8) & 0xff, den & 0xff,
  ],
});

const byteEntry = (tag: number, value: number): Entry => ({
  tag, type: TYPE_BYTE, count: 1, inline: value << 24,
});

const longEntry = (tag: number, value: number): Entry => ({
  tag, type: TYPE_LONG, count: 1, inline: value,
});

/**
 * Serialise one IFD.
 *
 * `base` is the offset of this IFD from the start of the TIFF header, which is
 * what out-of-line value offsets are measured against.
 */
function buildIfd(entries: Entry[], base: number, nextIfd = 0): { bytes: number[]; end: number } {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const headerSize = 2 + sorted.length * 12 + 4;
  let overflowAt = base + headerSize;

  const dir: number[] = [];
  const overflow: number[] = [];

  dir.push((sorted.length >> 8) & 0xff, sorted.length & 0xff);

  for (const e of sorted) {
    dir.push((e.tag >> 8) & 0xff, e.tag & 0xff);
    dir.push((e.type >> 8) & 0xff, e.type & 0xff);
    dir.push((e.count >>> 24) & 0xff, (e.count >>> 16) & 0xff, (e.count >>> 8) & 0xff, e.count & 0xff);

    if (e.data) {
      if (e.data.length <= 4) {
        const padded = [...e.data, 0, 0, 0, 0].slice(0, 4);
        dir.push(...padded);
      } else {
        dir.push(
          (overflowAt >>> 24) & 0xff, (overflowAt >>> 16) & 0xff,
          (overflowAt >>> 8) & 0xff, overflowAt & 0xff,
        );
        overflow.push(...e.data);
        // Values must start on a word boundary.
        if (e.data.length % 2) overflow.push(0);
        overflowAt += e.data.length + (e.data.length % 2);
      }
    } else {
      const v = e.inline ?? 0;
      dir.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    }
  }

  dir.push((nextIfd >>> 24) & 0xff, (nextIfd >>> 16) & 0xff, (nextIfd >>> 8) & 0xff, nextIfd & 0xff);
  return { bytes: [...dir, ...overflow], end: overflowAt };
}

export interface FixtureOptions {
  make?: string;
  model?: string;
  software?: string;
  lens?: string;
  serial?: string;
  /** EXIF format: "YYYY:MM:DD HH:MM:SS". */
  dateTimeOriginal?: string;
  modifyDate?: string;
  gps?: { lat: [number, number, number]; latRef: "N" | "S"; lon: [number, number, number]; lonRef: "E" | "W"; altitude?: number };
}

/** A JPEG carrying a real EXIF APP1 segment. */
export function buildJpegWithExif(opts: FixtureOptions): Uint8Array {
  // IFD0 sits at offset 8; its size is only known after the sub-IFDs are placed,
  // so both are built twice — once to measure, once with the real pointers.
  const ifd0Entries = (exifPtr: number, gpsPtr: number): Entry[] => {
    const e: Entry[] = [];
    if (opts.make) e.push(ascii(0x010f, opts.make));
    if (opts.model) e.push(ascii(0x0110, opts.model));
    if (opts.software) e.push(ascii(0x0131, opts.software));
    if (opts.modifyDate) e.push(ascii(0x0132, opts.modifyDate));
    if (exifPtr) e.push(longEntry(0x8769, exifPtr));
    if (gpsPtr) e.push(longEntry(0x8825, gpsPtr));
    return e;
  };

  const exifEntries: Entry[] = [];
  if (opts.dateTimeOriginal) exifEntries.push(ascii(0x9003, opts.dateTimeOriginal));
  if (opts.serial) exifEntries.push(ascii(0xa431, opts.serial));
  if (opts.lens) exifEntries.push(ascii(0xa434, opts.lens));

  const gpsEntries: Entry[] = [];
  if (opts.gps) {
    gpsEntries.push(ascii(0x0001, opts.gps.latRef));
    gpsEntries.push(dms(0x0002, ...opts.gps.lat));
    gpsEntries.push(ascii(0x0003, opts.gps.lonRef));
    gpsEntries.push(dms(0x0004, ...opts.gps.lon));
    if (opts.gps.altitude !== undefined) {
      gpsEntries.push(byteEntry(0x0005, 0));
      gpsEntries.push(rational(0x0006, Math.round(opts.gps.altitude * 100), 100));
    }
  }

  const TIFF_BASE = 8;
  // Pass 1: measure IFD0 with placeholder pointers so its length is known.
  const measured = buildIfd(ifd0Entries(exifEntries.length ? 1 : 0, gpsEntries.length ? 1 : 0), TIFF_BASE);
  const exifOffset = exifEntries.length ? TIFF_BASE + measured.bytes.length : 0;
  const exifIfd = exifEntries.length ? buildIfd(exifEntries, exifOffset) : { bytes: [], end: exifOffset };
  const gpsOffset = gpsEntries.length ? exifIfd.end : 0;
  const gpsIfd = gpsEntries.length ? buildIfd(gpsEntries, gpsOffset) : { bytes: [], end: gpsOffset };

  // Pass 2: same entry set, real pointers. Entry count and layout are unchanged,
  // so IFD0's length is identical to the measured pass.
  const ifd0 = buildIfd(ifd0Entries(exifOffset, gpsOffset), TIFF_BASE);

  const tiff = [
    0x4d, 0x4d, 0x00, 0x2a, // "MM" + 42
    0x00, 0x00, 0x00, 0x08, // IFD0 at offset 8
    ...ifd0.bytes,
    ...exifIfd.bytes,
    ...gpsIfd.bytes,
  ];

  const app1Payload = [...new TextEncoder().encode("Exif"), 0, 0, ...tiff];
  const app1Length = app1Payload.length + 2;

  return new Uint8Array([
    0xff, 0xd8,                                        // SOI
    0xff, 0xe1, (app1Length >> 8) & 0xff, app1Length & 0xff,
    ...app1Payload,
    ...MINIMAL_JPEG_BODY,
  ]);
}

/** A JPEG with no EXIF at all — the stripped-on-upload case. */
export function buildJpegWithoutExif(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, ...MINIMAL_JPEG_BODY]);
}

/**
 * Smallest structurally valid JPEG body: quantisation table, baseline frame,
 * Huffman tables, one scan of a single 8x8 grey block, EOI. Present so parsers
 * that validate structure before reading metadata do not reject the fixture.
 */
const MINIMAL_JPEG_BODY: number[] = [
  // DQT — flat table
  0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(0x10),
  // SOF0 — 8x8, one component
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x08, 0x00, 0x08, 0x01, 0x01, 0x11, 0x00,
  // DHT — DC table, one code
  0xff, 0xc4, 0x00, 0x1f, 0x00,
  0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
  // DHT — AC table, minimal
  0xff, 0xc4, 0x00, 0x14, 0x10,
  0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00,
  // SOS
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x00,
  // EOI
  0xff, 0xd9,
];

// ─── Synthetic images for perceptual-hash tests ────────────────────────────

/**
 * Deterministic RGBA test pattern. No Math.random() — a hash test that cannot be
 * reproduced byte for byte is not a test.
 */
export function syntheticImage(
  width: number,
  height: number,
  pattern: (x: number, y: number) => number,
): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = Math.max(0, Math.min(255, pattern(x, y)));
      const i = (y * width + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/** Box-filter resample of an RGBA image — stands in for a real resize. */
export function resample(
  src: { data: Uint8ClampedArray; width: number; height: number },
  width: number,
  height: number,
): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy0 = Math.floor((y * src.height) / height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * src.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sx0 = Math.floor((x * src.width) / width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * src.width) / width));
      let sum = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < src.height; sy += 1) {
        for (let sx = sx0; sx < sx1 && sx < src.width; sx += 1) {
          sum += src.data[(sy * src.width + sx) * 4];
          n += 1;
        }
      }
      const v = n ? sum / n : 0;
      const i = (y * width + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/**
 * Approximate JPEG requantisation: 8x8 block averaging blended back over the
 * original. Reproduces the block-level detail loss that real compression causes,
 * which is what the hash has to survive.
 */
export function requantise(
  src: { data: Uint8ClampedArray; width: number; height: number },
  strength: number,
): { data: Uint8ClampedArray; width: number; height: number } {
  const out = new Uint8ClampedArray(src.data);
  for (let by = 0; by < src.height; by += 8) {
    for (let bx = 0; bx < src.width; bx += 8) {
      let sum = 0, n = 0;
      for (let y = by; y < Math.min(by + 8, src.height); y += 1) {
        for (let x = bx; x < Math.min(bx + 8, src.width); x += 1) {
          sum += src.data[(y * src.width + x) * 4];
          n += 1;
        }
      }
      const mean = sum / n;
      for (let y = by; y < Math.min(by + 8, src.height); y += 1) {
        for (let x = bx; x < Math.min(bx + 8, src.width); x += 1) {
          const i = (y * src.width + x) * 4;
          const v = src.data[i] * (1 - strength) + mean * strength;
          out[i] = v; out[i + 1] = v; out[i + 2] = v;
        }
      }
    }
  }
  return { data: out, width: src.width, height: src.height };
}
