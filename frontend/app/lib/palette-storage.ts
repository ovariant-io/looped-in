/**
 * The colour picker's persisted state — validated, versioned, per browser.
 *
 * Nothing here reaches the server: a palette is a local preview, not an account setting,
 * which is what lets the picker work on the signed-out landing page where there is no
 * session. Making a permutation permanent stays a deliberate code edit (the panel's
 * "Copy CSS" writes the block to paste into globals.css).
 *
 * Everything read back out is re-validated rather than trusted. The stored value is
 * user-writable, and it is fed straight into `style.setProperty` and an inline boot
 * script — so a stray value should degrade to the shipped palette, never render.
 */

import { ANCHOR_KEYS, PRESETS, isHex, type Palette, type Scheme } from "./palette";

export interface PickerState {
  /** null = no overrides; the app follows globals.css. */
  palette: Palette | null;
  presetId: string;
  /** null = follow the OS. */
  scheme: Scheme | null;
}

/** Also read by the inline boot script in app/lib/palette-boot.tsx — keep them in step. */
export const STORAGE_KEY = "looped-in:palette:v1";

export const DEFAULT_STATE: PickerState = {
  palette: null,
  presetId: PRESETS[0].id,
  scheme: null,
};

const VALID_PRESET_IDS = new Set([...PRESETS.map((p) => p.id), "custom"]);

/** null = absent (use the shipped palette); undefined = present but malformed. */
function normalizePalette(value: unknown): Palette | null | undefined {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;

  const source = value as Record<string, unknown>;
  const palette = {} as Palette;
  for (const key of ANCHOR_KEYS) {
    const colour = source[key];
    // Every anchor must be present: a partial palette would leave some tokens overridden
    // and others not, which is a blend of two designs rather than either one.
    if (!isHex(colour)) return undefined;
    palette[key] = colour.toLowerCase();
  }
  return palette;
}

function normalizeState(value: unknown): PickerState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const source = value as Record<string, unknown>;
  const palette = normalizePalette(source.palette);
  if (palette === undefined) return null;

  const presetId =
    typeof source.presetId === "string" && VALID_PRESET_IDS.has(source.presetId)
      ? source.presetId
      : null;

  return {
    palette,
    // A stored palette with an unrecognised preset id is still a real palette; it is just
    // no longer one of ours, so it reads back as "custom".
    presetId: palette ? (presetId ?? "custom") : DEFAULT_STATE.presetId,
    scheme: source.scheme === "light" || source.scheme === "dark" ? source.scheme : null,
  };
}

export function readPickerState(): PickerState | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const state = normalizeState(JSON.parse(raw));
    if (!state) window.localStorage.removeItem(STORAGE_KEY);
    return state;
  } catch {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage may be unavailable entirely; callers fall back to the shipped palette.
    }
    return null;
  }
}

/** Merge a patch over the stored state and persist only what validates. */
export function savePickerState(patch: Partial<PickerState>): void {
  if (typeof window === "undefined") return;

  try {
    const next = normalizeState({ ...(readPickerState() ?? DEFAULT_STATE), ...patch });
    if (!next) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode, quota limits and disabled storage must not break theming.
  }
}
