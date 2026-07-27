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
 * **The `<img>` is always the light lockup, and dark is a stylesheet concern.** This used to
 * be a `<picture>` whose `<source>` matched `prefers-color-scheme`, which was right while the
 * ground followed the OS. It no longer does: the app ships light and goes dark only for an
 * explicit `data-li-scheme`, and a `<source>` cannot see an attribute. Left as it was, every
 * dark-mode machine would be served the cream wordmark and paint it onto the light ground,
 * where it is invisible.
 *
 * So the dark artwork is painted as a background and the `<img>` faded out, under exactly the
 * conditions globals.css turns the ground dark. A background-image in a rule that does not
 * match is never requested, so the default — light, which is now most visitors — still fetches
 * one file and runs no JS. Opting into dark costs the second fetch.
 *
 * `next/image` is still not usable here: the `<img>` has to be the element the stylesheet
 * hides, and the background has to sit on a wrapper it does not control.
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
    // The wrapper carries the dark artwork as a background; the <img> below is what gets
    // hidden, so the two cannot be the same element (opacity would take the background
    // with it). It also lays out the box, so the background needs no dimensions.
    <span className={styles.frame}>
      {/* eslint-disable-next-line @next/next/no-img-element -- the rule's exemption is for
          <img> inside <picture>, which this deliberately no longer is. next/image would
          route a ~9 KB static lockup through the optimizer Lambda for no gain, and this
          element has to stay something the stylesheet can fade to swap the dark artwork
          in. The lint concern (unoptimized LCP image) is answered by the caller's
          `priority`, which sets eager loading and high fetch priority below. */}
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
    </span>
  );
}
