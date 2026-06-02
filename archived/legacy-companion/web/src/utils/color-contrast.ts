type Rgb = { r: number; g: number; b: number; a: number };

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function parseHexColor(value: string): Rgb | null {
  const hex = value.trim().toLowerCase();
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(hex);
  if (!match) return null;
  const digits = match[1].length === 3
    ? match[1].split("").map((c) => `${c}${c}`).join("")
    : match[1];
  const intValue = Number.parseInt(digits, 16);
  return {
    r: (intValue >> 16) & 255,
    g: (intValue >> 8) & 255,
    b: intValue & 255,
    a: 1,
  };
}

function parseRgbColor(value: string): Rgb | null {
  const normalized = value.trim().toLowerCase();
  const rgbMatch = /^rgb\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)$/.exec(normalized);
  if (rgbMatch) {
    return {
      r: clampByte(Number.parseFloat(rgbMatch[1])),
      g: clampByte(Number.parseFloat(rgbMatch[2])),
      b: clampByte(Number.parseFloat(rgbMatch[3])),
      a: 1,
    };
  }

  const rgbaMatch = /^rgba\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)$/.exec(normalized);
  if (!rgbaMatch) return null;
  return {
    r: clampByte(Number.parseFloat(rgbaMatch[1])),
    g: clampByte(Number.parseFloat(rgbaMatch[2])),
    b: clampByte(Number.parseFloat(rgbaMatch[3])),
    a: Math.max(0, Math.min(1, Number.parseFloat(rgbaMatch[4]))),
  };
}

export function parseColor(value: string): Rgb | null {
  return parseHexColor(value) || parseRgbColor(value);
}

function blend(foreground: Rgb, background: Rgb): Rgb {
  const alpha = foreground.a;
  const invAlpha = 1 - alpha;
  return {
    r: Math.round((foreground.r * alpha) + (background.r * invAlpha)),
    g: Math.round((foreground.g * alpha) + (background.g * invAlpha)),
    b: Math.round((foreground.b * alpha) + (background.b * invAlpha)),
    a: 1,
  };
}

function toLinear(value: number): number {
  const normalized = value / 255;
  if (normalized <= 0.03928) return normalized / 12.92;
  return ((normalized + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: string, backgroundColor?: string): number {
  const parsed = parseColor(color);
  if (!parsed) {
    throw new Error(`Unsupported color format: ${color}`);
  }

  let effective = parsed;
  if (parsed.a < 1) {
    if (!backgroundColor) {
      throw new Error("Alpha color requires a backgroundColor to compute luminance.");
    }
    const bg = parseColor(backgroundColor);
    if (!bg) {
      throw new Error(`Unsupported background color format: ${backgroundColor}`);
    }
    effective = blend(parsed, bg);
  }

  return (0.2126 * toLinear(effective.r)) + (0.7152 * toLinear(effective.g)) + (0.0722 * toLinear(effective.b));
}

export function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}
