import styles from "./brand-logo.module.css";

/**
 * The Looped In lockup — the official artwork from the brand site, not a rebuild.
 *
 * Two variants ship in `public/`: `looped-in-logo.png` is the file the brand site serves
 * (plum wordmark #351f40 + indigo mark #4f67b1 on transparency), and `looped-in-logo-dark.png`
 * is the same artwork with the wordmark re-inked to cream for the dark scheme — plum on the
 * warm near-black ground is about 1.4:1, which is unreadable. The indigo mark is left alone in
 * both: it measures 3.48:1 on the dark ground, clear of the 3:1 threshold for graphics, and
 * recolouring the mark would mean shipping a logo that isn't the brand's.
 *
 * `<picture>` with a `prefers-color-scheme` source does the swap in the browser's image
 * selection, so only the matching file is ever fetched and there is no JS, no flash, and no
 * hydration boundary. `next/image` has no equivalent — it cannot emit media-conditional
 * sources — which is why this is a plain `<img>`.
 *
 * The one thing `<picture>` cannot see is the colour picker pinning a scheme: its source is
 * matched on `prefers-color-scheme`, so a pinned light preview on a dark-scheme machine would
 * still be served the cream wordmark and paint it onto the cream ground. The stylesheet covers
 * that case by painting the right artwork as a background and hiding the `<img>` — and because
 * a background-image in a rule that does not match is never requested, the ordinary unpinned
 * path still fetches exactly one file and runs no JS.
 *
 * If the brand ever supplies an official reversed lockup, replace the generated dark PNG with
 * it; nothing here has to change.
 */
export function BrandLogo({
  className,
  priority = false,
}: {
  className?: string;
  priority?: boolean;
}) {
  return (
    <picture className={styles.picture}>
      <source
        srcSet="/looped-in-logo-dark.png"
        media="(prefers-color-scheme: dark)"
      />
      {/* A bare <img> on purpose: next/image cannot express a <picture> media source,
          which is what selects the light/dark lockup without JS. */}
      <img
        src="/looped-in-logo.png"
        alt="Looped In"
        width={1249}
        height={186}
        className={`${styles.logo}${className ? ` ${className}` : ""}`}
        // The lockup is the largest contentful paint on both the landing page and
        // the shell header, so those callers opt it out of lazy loading.
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        decoding="async"
      />
    </picture>
  );
}
