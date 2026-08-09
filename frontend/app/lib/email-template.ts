import { DEFAULT_PALETTE } from "@/app/lib/palette";

/**
 * Renders a campaign message into the branded HTML email.
 *
 * **Every colour is a literal hex baked from `DEFAULT_PALETTE` at module load** — email clients
 * support neither `var()` nor `color-mix()`, so the design system's cascade cannot run here and
 * the few derivations the template needs (the hairline rule) are re-implemented as an srgb lerp
 * below. That is a stated divergence from "one palette write re-themes every surface": the colour
 * picker restyles the app, but an outbound email is brand collateral, not a per-browser
 * preference, so it always renders the shipped palette's light scheme.
 *
 * **The markup is 100% first-party and every interpolation is escaped.** The body is plain text
 * (paragraphs separated by blank lines) and this module owns all the HTML around it — which is
 * what makes the campaign page's fully-sandboxed `<iframe srcDoc>` preview safe without a
 * sanitizer dependency.
 *
 * This must stay an **imported TS module**, never a file read from disk at runtime: with
 * `output: "standalone"`, only traced imports ship in the Docker/Lambda image.
 *
 * The wordmark is styled text, not the logo PNG — an email can only show an image it can fetch
 * (hosting) or that is attached (CID), both of which are sending infrastructure this repo
 * deliberately doesn't have. Compliance furniture (unsubscribe links, sender address) belongs to
 * whatever tool actually sends; nothing here transmits an email.
 */

// The light scheme, flattened. Dark-mode mail clients are told to leave it alone via the
// color-scheme meta plus explicit colors on every cell.
const bg = DEFAULT_PALETTE.cream;
const fg = DEFAULT_PALETTE.ink;
const wordmark = DEFAULT_PALETTE.plum;
const meta = DEFAULT_PALETTE.eggplant;
const line = mix(fg, bg, 0.14); // --li-line, flattened over the ground instead of transparency.

const FONT_STACK = "Helvetica, Arial, sans-serif";

export function renderEmailHtml({
  subject,
  bodyText,
}: {
  subject: string;
  bodyText: string;
}): string {
  const paragraphs = bodyText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .map(
      (paragraph) =>
        // A single newline inside a paragraph is a soft break, not a new paragraph.
        `<p style="margin:0 0 16px;font-family:${FONT_STACK};font-size:16px;line-height:1.55;color:${fg};">` +
        escapeHtml(paragraph).replaceAll("\n", "<br />") +
        "</p>",
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="color-scheme" content="light" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${bg};" bgcolor="${bg}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${bg};" bgcolor="${bg}">
<tr>
<td align="center" style="padding:32px 16px;background-color:${bg};" bgcolor="${bg}">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;">
<tr>
<td style="padding:0 4px 20px;background-color:${bg};" bgcolor="${bg}">
<span style="font-family:${FONT_STACK};font-size:18px;font-weight:700;letter-spacing:0.02em;text-transform:uppercase;color:${wordmark};">Looped&nbsp;In</span>
</td>
</tr>
<tr>
<td style="border-top:1px solid ${line};padding:24px 4px 8px;background-color:${bg};" bgcolor="${bg}">
${paragraphs}
</td>
</tr>
<tr>
<td style="border-top:1px solid ${line};padding:16px 4px 0;background-color:${bg};" bgcolor="${bg}">
<span style="font-family:${FONT_STACK};font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:${meta};">Looped&nbsp;In</span>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}

/** The same message for a plain-text mail client — subject line up top, body verbatim. */
export function renderEmailText({
  subject,
  bodyText,
}: {
  subject: string;
  bodyText: string;
}): string {
  return `Subject: ${subject}\n\n${bodyText.trim()}\n`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A per-channel srgb lerp of `weight` of `over` onto `under` — color-mix, by hand. */
function mix(over: string, under: string, weight: number): string {
  const a = channels(over);
  const b = channels(under);
  const blended = a.map((channel, index) =>
    Math.round(channel * weight + b[index] * (1 - weight)),
  );
  return `#${blended.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function channels(hex: string): number[] {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
}
