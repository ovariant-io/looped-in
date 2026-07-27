"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ANCHORS,
  DEFAULT_PALETTE,
  DEFAULT_SCHEME,
  PALETTE_EVENT,
  PRESETS,
  SHIPPED_PRESET_ID,
  buildThemeCss,
  checkContrast,
  decodePalette,
  encodePalette,
  randomPalette,
  type Palette,
  type Scheme,
} from "./palette";
import { readPickerState, savePickerState } from "./palette-storage";
import styles from "./colour-picker.module.css";

/**
 * A permanent palette picker, mounted once in the root layout so it rides every screen —
 * the landing page and its WebGL scene, the auth pages, and everything behind sign-in.
 *
 * It re-themes the app by writing the seven raw brand colours as inline custom properties
 * on <html>. Nothing else changes: every semantic token in globals.css derives from those
 * seven through var() and color-mix(), so one write reaches every CSS module at once. That
 * is also the reason this panel styles itself from the same tokens — it wears the palette
 * it is editing, so a permutation that hurts to read is visibly one.
 *
 * Two things this needs that a plain swatch grid would not:
 *
 * - **A scheme pin.** Two of the seven anchors only ever show up in the dark scheme, so on
 *   a light-mode machine they would otherwise be uneditable. `data-li-scheme` forces the
 *   scheme; globals.css honours it, and "auto" is the value that hands the choice back to
 *   the OS. The app itself ships light, so with no attribute set there is nothing to undo.
 * - **A contrast readout.** Looped In's token table is *argued* from contrast, so the way
 *   a permutation fails is by quietly dropping a pair below its threshold rather than by
 *   looking wrong. CONTRAST_CHECKS puts those ratios on screen while you drag.
 *
 * Choices are per-browser (localStorage) and shareable as `?palette=` links; nothing is
 * written to the site. To make one permanent: "Copy CSS", paste over the raw block in
 * app/globals.css, then mirror it into DEFAULT_PALETTE in app/lib/palette.ts.
 */

function writeVars(palette: Palette | null) {
  const { style } = document.documentElement;
  for (const anchor of ANCHORS) {
    if (palette) style.setProperty(anchor.cssVar, palette[anchor.key]);
    else style.removeProperty(anchor.cssVar);
  }
  window.dispatchEvent(new Event(PALETTE_EVENT));
}

function writeScheme(scheme: Scheme) {
  document.documentElement.setAttribute("data-li-scheme", scheme);
  window.dispatchEvent(new Event(PALETTE_EVENT));
}

/**
 * Light first, because that is what the app ships — so the default state always has a
 * button lit rather than looking like nothing is selected. "Auto" is the opt-in that
 * hands the choice back to the OS; it is no longer what happens when you choose nothing.
 */
const SCHEME_OPTIONS: { value: Scheme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "auto", label: "Auto" },
];

export function ColourPicker() {
  const [open, setOpen] = useState(false);
  // null = no overrides, so the app renders exactly what globals.css ships.
  const [palette, setPalette] = useState<Palette | null>(null);
  const [presetId, setPresetId] = useState<string>(SHIPPED_PRESET_ID);
  // No attribute on <html> renders as DEFAULT_SCHEME, so React starts where the DOM is.
  const [scheme, setScheme] = useState<Scheme>(DEFAULT_SCHEME);
  const [copied, setCopied] = useState("");

  const apply = useCallback((next: Palette | null, id: string) => {
    writeVars(next);
    setPalette(next);
    setPresetId(id);
    savePickerState({ palette: next, presetId: id });
  }, []);

  const applyScheme = useCallback((next: Scheme) => {
    writeScheme(next);
    setScheme(next);
    savePickerState({ scheme: next });
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- one-time client bootstrap: the URL
     and localStorage only exist after mount, and the inline boot script has already put
     the same values on <html>, so this is syncing React up to the DOM rather than
     changing it. */
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("palette");
    // A shared link wins over the saved palette, so a link always shows the sender's.
    const shared = param ? decodePalette(param) : null;
    const saved = readPickerState();

    if (shared) apply(shared.palette, shared.presetId);
    else if (saved?.palette) apply(saved.palette, saved.presetId);

    if (saved?.scheme) applyScheme(saved.scheme);
  }, [apply, applyScheme]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const active = palette ?? DEFAULT_PALETTE;
  const results = useMemo(() => checkContrast(active), [active]);
  const failures = results.filter((result) => !result.passes).length;

  const copy = async (kind: "link" | "css") => {
    const preset = PRESETS.find((p) => p.id === presetId);
    let text: string;
    if (kind === "css") {
      text = buildThemeCss(active, preset ? preset.name : "custom permutation");
    } else {
      const url = new URL(window.location.href);
      // Prefer the preset's id — a four-word link beats forty-two hex characters.
      url.searchParams.set(
        "palette",
        preset ? preset.id : encodePalette(active),
      );
      text = url.toString();
    }

    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(""), 1600);
    } catch {
      // Blocked over plain http, or by permissions. Still give them the text.
      window.prompt("Copy this:", text);
    }
  };

  return (
    <div className={styles.root}>
      {open && (
        <div className={styles.panel} role="dialog" aria-label="Colour picker">
          <div className={styles.head}>
            <div>
              {/* The verdict rides in the header, not only above the readout below: the
                  panel is taller than it is on screen, and "this permutation is broken"
                  is not something you should have to scroll to find out. */}
              <p className={styles.titleRow}>
                <span className={styles.eyebrow}>Palette</span>
                <span
                  className={`${styles.badge}${failures ? ` ${styles.badgeBad}` : ""}`}
                >
                  {failures ? `${failures} below target` : "All pass"}
                </span>
              </p>
              <p className={styles.blurb}>
                Only this browser sees these colours. Share a link when you find one
                you like.
              </p>
            </div>
            <button
              type="button"
              className={styles.close}
              onClick={() => setOpen(false)}
              aria-label="Close the colour picker"
            >
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
            </button>
          </div>

          <div className={styles.presets}>
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`${styles.preset}${
                  presetId === preset.id ? ` ${styles.presetActive}` : ""
                }`}
                aria-pressed={presetId === preset.id}
                onClick={() =>
                  apply(
                    // The shipped preset means "no overrides" rather than "these seven
                    // hexes", so globals.css keeps ownership of the brand.
                    preset.id === SHIPPED_PRESET_ID ? null : { ...preset.palette },
                    preset.id,
                  )
                }
                style={{ background: preset.palette.cream }}
              >
                <span className={styles.presetChips} aria-hidden="true">
                  {(["indigo", "sky", "plum", "eggplant"] as const).map((key) => (
                    <span
                      key={key}
                      className={styles.presetChip}
                      style={{ background: preset.palette[key] }}
                    />
                  ))}
                </span>
                <span
                  className={styles.presetName}
                  style={{ color: preset.palette.ink }}
                >
                  {preset.name}
                </span>
                <span
                  className={styles.presetBlurb}
                  style={{ color: preset.palette.eggplant }}
                >
                  {preset.blurb}
                </span>
              </button>
            ))}
          </div>

          <p className={styles.eyebrow}>Mix your own</p>
          <div className={styles.wells}>
            {ANCHORS.map((anchor) => (
              <label key={anchor.key} className={styles.well}>
                <span className={styles.wellText}>
                  <span className={styles.wellLabel}>{anchor.label}</span>
                  <span className={styles.wellHint}>{anchor.hint}</span>
                </span>
                <input
                  type="color"
                  className={styles.swatch}
                  value={active[anchor.key]}
                  onChange={(event) =>
                    apply({ ...active, [anchor.key]: event.target.value }, "custom")
                  }
                />
              </label>
            ))}
          </div>

          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              onClick={() => apply(randomPalette(), "custom")}
            >
              Surprise me
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.ghost}`}
              onClick={() => apply(null, SHIPPED_PRESET_ID)}
            >
              Reset
            </button>
          </div>

          <p className={styles.eyebrow}>Preview scheme</p>
          <div className={styles.schemes} role="group" aria-label="Preview scheme">
            {SCHEME_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                className={`${styles.button} ${styles.ghost} ${styles.schemeButton}${
                  scheme === option.value ? ` ${styles.schemeActive}` : ""
                }`}
                aria-pressed={scheme === option.value}
                onClick={() => applyScheme(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <p className={styles.eyebrow}>Contrast</p>
          {(["light", "dark"] as const).map((group) => (
            <div key={group} className={styles.checkGroup}>
              <p className={styles.checkGroupLabel}>
                {group === "light" ? "Light scheme" : "Dark scheme"}
              </p>
              {results
                .filter((result) => result.scheme === group)
                .map((result) => (
                  <p key={result.id} className={styles.check}>
                    <span className={styles.checkLabel}>{result.label}</span>
                    <span
                      className={`${styles.ratio}${
                        result.passes ? "" : ` ${styles.ratioBad}`
                      }`}
                    >
                      {result.ratio.toFixed(1)}:1
                      <span className={styles.target}> / {result.min}</span>
                    </span>
                  </p>
                ))}
            </div>
          ))}

          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.button} ${styles.ghost}`}
              onClick={() => void copy("link")}
            >
              {copied === "link" ? "Link copied" : "Copy link"}
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.ghost}`}
              onClick={() => void copy("css")}
            >
              {copied === "css" ? "CSS copied" : "Copy CSS"}
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        className={styles.bubble}
        onClick={() => setOpen((value) => !value)}
        aria-label={open ? "Close the colour picker" : "Open the colour picker"}
        aria-expanded={open}
      >
        {/* The swatch is painted from the custom properties themselves, so the inline boot
            script colours it before React runs and there is nothing to hydrate. */}
        <span className={styles.bubbleSwatch} aria-hidden="true" />
      </button>
    </div>
  );
}
