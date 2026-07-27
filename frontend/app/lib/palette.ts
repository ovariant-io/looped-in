/**
 * The colour model behind the picker (app/lib/colour-picker.tsx).
 *
 * app/globals.css declares every colour as a CSS custom property, and every semantic
 * token is a var() or color-mix() of seven raw anchors. So a palette permutation is just
 * seven inline custom-property overrides on <html>: every route, every CSS module and the
 * landing scene re-theme at once, and no component knows it happened.
 *
 * Because the semantic layer already does the deriving, there is deliberately no ramp
 * engine here. The theme lab this is modelled on has ten-step ramps to rebuild from each
 * anchor and needs OKLCH tonal templates to do it; Looped In has seven colours and a
 * cascade. What this design system needs instead is a **contrast readout** — the token
 * table in CLAUDE.md is *justified* by contrast (sky is ~1.03:1 on cream, the plum
 * wordmark ~1.4:1 on the dark ground), so the failure mode worth surfacing is a
 * permutation that quietly breaks those ratios. CONTRAST_CHECKS encodes the pairs the
 * design already depends on, and the randomiser refuses to hand back a palette that
 * fails them.
 *
 * DEFAULT_PALETTE mirrors the :root block of app/globals.css. If the shipped brand
 * colours are ever retuned, retune this map with them.
 *
 * No server imports: this module is pulled into a client component.
 */

export type AnchorKey =
  | "cream"
  | "ink"
  | "indigo"
  | "sky"
  | "eggplant"
  | "plum"
  | "night";

export type Palette = Record<AnchorKey, string>;

/** Which colour scheme a permutation is being judged in. `null` = follow the OS. */
export type Scheme = "light" | "dark";

export interface Anchor {
  key: AnchorKey;
  /** The custom property in globals.css this anchor writes. */
  cssVar: string;
  /** What the colour *does*. A picker should ask about roles, not hues — a preset is
   *  free to make "indigo" a rust, and then only the role still describes it. */
  label: string;
  /** The shipped colour's name, so the brand table stays recognisable. */
  hint: string;
}

/**
 * Anchor order is the wire format for `?palette=` links. Append only; never reorder,
 * or an old link decodes into a different palette than the one that was shared.
 */
export const ANCHORS: readonly Anchor[] = [
  {
    key: "cream",
    cssVar: "--li-cream",
    label: "Ground · light",
    hint: "cream — the page behind everything",
  },
  {
    key: "ink",
    cssVar: "--li-ink",
    label: "Text · light",
    hint: "ink — body and headings",
  },
  {
    key: "indigo",
    cssVar: "--li-indigo",
    label: "Rules & links",
    hint: "indigo — connector lines, focus rings",
  },
  {
    key: "sky",
    cssVar: "--li-sky",
    label: "Accent tint",
    hint: "sky — chips and highlights",
  },
  {
    key: "eggplant",
    cssVar: "--li-eggplant",
    label: "Meta · light",
    hint: "eggplant — Space Mono eyebrows",
  },
  {
    key: "plum",
    cssVar: "--li-plum",
    label: "Scene nodes",
    hint: "plum — the wordmark ink",
  },
  {
    key: "night",
    cssVar: "--li-night",
    label: "Ground · dark",
    hint: "night — the dark scheme's page",
  },
] as const;

export const ANCHOR_KEYS: readonly AnchorKey[] = ANCHORS.map((a) => a.key);

/**
 * Fired on `window` whenever the picker rewrites the custom properties.
 *
 * CSS re-themes itself, but anything holding a colour outside the cascade has to be told.
 * Today that is only the landing scene, which pushes hexes into WebGL materials — a
 * MutationObserver on <html>'s style attribute would work too, but an explicit event says
 * what happened instead of making every listener infer it.
 */
export const PALETTE_EVENT = "looped-in:palette";

/** Mirrors the :root block of app/globals.css. */
export const DEFAULT_PALETTE: Palette = {
  cream: "#e0dccc",
  ink: "#000000",
  indigo: "#4e67b1",
  sky: "#bbdfe8",
  eggplant: "#472700",
  plum: "#351f40",
  night: "#1a130a",
};

const HEX = /^#[0-9a-f]{6}$/i;

export const isHex = (value: unknown): value is string =>
  typeof value === "string" && HEX.test(value);

/* ---------- contrast (WCAG 2.1) ---------- */

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function toRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toLinear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export function relativeLuminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1–21. Order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface ContrastCheck {
  id: string;
  scheme: Scheme;
  label: string;
  fg: AnchorKey;
  bg: AnchorKey;
  /**
   * 4.5 wherever the pair carries text. The eyebrows are 12px at weight 700, which is
   * under WCAG's large-text threshold (18.66px bold), so they get the full 4.5 rather
   * than the 3.0 large text would allow. 3.0 is for the pairs that are only ever
   * graphics: connector rules and the scene's geometry.
   */
  min: number;
}

export const CONTRAST_CHECKS: readonly ContrastCheck[] = [
  { id: "body-light", scheme: "light", label: "Body text", fg: "ink", bg: "cream", min: 4.5 },
  { id: "meta-light", scheme: "light", label: "Eyebrows", fg: "eggplant", bg: "cream", min: 4.5 },
  { id: "chip-light", scheme: "light", label: "Text on accent", fg: "ink", bg: "sky", min: 4.5 },
  { id: "rule-light", scheme: "light", label: "Rules", fg: "indigo", bg: "cream", min: 3 },
  { id: "scene-light", scheme: "light", label: "Scene nodes", fg: "plum", bg: "cream", min: 3 },
  { id: "body-dark", scheme: "dark", label: "Body text", fg: "cream", bg: "night", min: 4.5 },
  // Sky carries both the eyebrows and the rules on the dark ground, so the stricter
  // text threshold covers the rules too — there is no separate indigo rule to check,
  // which is the whole point of the swap in globals.css.
  { id: "meta-dark", scheme: "dark", label: "Eyebrows & rules", fg: "sky", bg: "night", min: 4.5 },
  // What indigo *does* keep on the dark ground is the scene's mark, which does not swap.
  { id: "scene-dark", scheme: "dark", label: "Scene mark", fg: "indigo", bg: "night", min: 3 },
];

export interface ContrastResult extends ContrastCheck {
  ratio: number;
  passes: boolean;
}

export function checkContrast(palette: Palette): ContrastResult[] {
  return CONTRAST_CHECKS.map((check) => {
    const ratio = contrastRatio(palette[check.fg], palette[check.bg]);
    // Round before comparing so a ratio the UI prints as "4.5" is never marked failing.
    const shown = Math.round(ratio * 10) / 10;
    return { ...check, ratio: shown, passes: shown >= check.min };
  });
}

/* ---------- OKLCH, for the randomiser ---------- */

// Only what the randomiser needs: a perceptual space to draw from, so a random palette
// lands on believable lightness relationships instead of the confetti a random 24-bit
// hex would give. Coefficients are Ottosson's.

const toGamma = (v: number) =>
  (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255;

function oklchToRgb(l: number, c: number, h: number): number[] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toGamma(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
    toGamma(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
    toGamma(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
  ];
}

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -0.01 && v <= 255.01);

/** OKLCH → hex, walking chroma back toward grey until the colour fits sRGB. */
export function oklchToHex(l: number, c: number, h: number): string {
  const lightness = clamp(l, 0, 1);
  let rgb = oklchToRgb(lightness, c, h);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 16; i += 1) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToRgb(lightness, mid, h))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToRgb(lightness, lo, h);
  }
  return `#${rgb
    .map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0"))
    .join("")}`;
}

function drawPalette(): Palette {
  const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
  const hue = rand(0, 360);
  // The ground is tinted away from the primary rather than with it — that warm-cream
  // against cool-indigo tension is the brand's own relationship, kept structurally.
  const warm = (hue + rand(140, 220)) % 360;
  const wrap = (h: number) => ((h % 360) + 360) % 360;

  return {
    cream: oklchToHex(rand(0.885, 0.915), rand(0.012, 0.03), warm),
    ink: oklchToHex(rand(0.14, 0.22), rand(0, 0.02), warm),
    indigo: oklchToHex(rand(0.44, 0.52), rand(0.09, 0.16), hue),
    sky: oklchToHex(rand(0.85, 0.9), rand(0.04, 0.08), wrap(hue + rand(-25, 25))),
    eggplant: oklchToHex(rand(0.3, 0.38), rand(0.05, 0.1), warm),
    plum: oklchToHex(rand(0.3, 0.4), rand(0.05, 0.11), wrap(hue + rand(150, 210))),
    night: oklchToHex(rand(0.16, 0.21), rand(0.012, 0.03), warm),
  };
}

/**
 * A random permutation that still passes every contrast check.
 *
 * The draw ranges are chosen to land inside the checks, but chroma and hue both move
 * luminance around, so the edges of those ranges can still fall short. Rather than
 * narrow the ranges until nothing interesting comes out, draw and re-draw, and if the
 * budget runs out hand back the closest attempt — a picker that can produce an
 * illegible theme is a picker nobody can trust to judge one.
 */
export function randomPalette(): Palette {
  let best = drawPalette();
  let bestFailures = checkContrast(best).filter((c) => !c.passes).length;

  for (let attempt = 0; attempt < 32 && bestFailures > 0; attempt += 1) {
    const candidate = drawPalette();
    const failures = checkContrast(candidate).filter((c) => !c.passes).length;
    if (failures < bestFailures) {
      best = candidate;
      bestFailures = failures;
    }
  }
  return best;
}

/* ---------- presets ---------- */

export interface Preset {
  id: string;
  name: string;
  blurb: string;
  palette: Palette;
}

export const SHIPPED_PRESET_ID = "looped-in";

export const PRESETS: readonly Preset[] = [
  {
    id: SHIPPED_PRESET_ID,
    name: "Looped In",
    blurb: "The brand site's own palette",
    palette: { ...DEFAULT_PALETTE },
  },
  {
    id: "harbour",
    name: "Harbour",
    blurb: "Storm slate on cool paper",
    palette: {
      cream: "#dcdfe3",
      ink: "#0c1116",
      indigo: "#4d7ba9",
      sky: "#c2dced",
      eggplant: "#33404a",
      plum: "#24333f",
      night: "#111820",
    },
  },
  {
    id: "eucalypt",
    name: "Eucalypt",
    blurb: "Gum leaf and ironbark",
    palette: {
      cream: "#e2e2d2",
      ink: "#0e150f",
      indigo: "#3d7d5c",
      sky: "#c3e2ce",
      eggplant: "#3a3a1c",
      plum: "#2b3f31",
      night: "#141a13",
    },
  },
  {
    id: "ember",
    name: "Ember",
    blurb: "Kiln-fired clay, led by warmth",
    palette: {
      cream: "#ecded0",
      ink: "#1b120c",
      indigo: "#a8552c",
      sky: "#f2cdae",
      eggplant: "#54291a",
      plum: "#432a20",
      night: "#1e1410",
    },
  },
  {
    id: "dusk",
    name: "Dusk",
    blurb: "Twilight violet and candle amber",
    palette: {
      cream: "#e4dee6",
      ink: "#140f1c",
      indigo: "#6250bf",
      sky: "#cfc7ee",
      eggplant: "#4a3417",
      plum: "#3a2b52",
      night: "#171325",
    },
  },
  {
    id: "graphite",
    name: "Graphite",
    blurb: "Near-neutral, for when colour is the content",
    palette: {
      cream: "#e2e0dd",
      ink: "#101010",
      indigo: "#6f6f6d",
      sky: "#d2d0cd",
      eggplant: "#3d3a36",
      plum: "#2e2c2a",
      night: "#161514",
    },
  },
];

/* ---------- share links & CSS export ---------- */

export function encodePalette(palette: Palette): string {
  return ANCHORS.map((a) => palette[a.key].slice(1)).join(".");
}

/** A `?palette=` value → a preset id or seven hexes. Unrecognised input returns null. */
export function decodePalette(
  code: string,
): { presetId: string; palette: Palette | null } | null {
  const preset = PRESETS.find((p) => p.id === code);
  if (preset) {
    return {
      presetId: preset.id,
      // The shipped preset is "no overrides", so the app keeps following globals.css.
      palette: preset.id === SHIPPED_PRESET_ID ? null : { ...preset.palette },
    };
  }

  const parts = code.split(".");
  if (parts.length !== ANCHORS.length) return null;
  if (!parts.every((p) => /^[0-9a-f]{6}$/i.test(p))) return null;

  const palette = { ...DEFAULT_PALETTE };
  ANCHORS.forEach((anchor, i) => {
    palette[anchor.key] = `#${parts[i].toLowerCase()}`;
  });
  return { presetId: "custom", palette };
}

/** Paste-ready replacements for the raw-colour block in app/globals.css. */
export function buildThemeCss(palette: Palette, label = "custom permutation"): string {
  const width = Math.max(...ANCHORS.map((a) => a.cssVar.length));
  return [
    `/* Looped In — colour picker export (${label}).`,
    "   Paste over the raw brand colours in the :root block of frontend/app/globals.css,",
    "   then mirror the same values into DEFAULT_PALETTE in frontend/app/lib/palette.ts. */",
    "",
    ...ANCHORS.map(
      (a) => `  ${`${a.cssVar}:`.padEnd(width + 1)} ${palette[a.key]}; /* ${a.label} */`,
    ),
    "",
  ].join("\n");
}
