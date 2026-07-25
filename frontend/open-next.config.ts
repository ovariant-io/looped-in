/**
 * OpenNext configuration for the Looped In frontend (consumed by SST's `Nextjs` component at deploy).
 *
 * Enables AWS Lambda **response streaming** for the Next.js server function. OpenNext's default
 * wrapper buffers the entire response before returning it, which means nothing reaches the
 * browser until the server is completely done — and any response the server streams gets
 * truncated at the wrapper.
 *
 * That mattered acutely when this app ran with `cacheComponents: true` (PPR): the static shell
 * would arrive but the Suspense continuations never would, so the browser threw "Connection
 * closed" and dynamic UI (the Clerk auth nav) stayed empty. `cacheComponents` is **off** today
 * — see the note in `next.config.ts` — so that specific failure is not live.
 *
 * The wrapper is kept anyway, for two reasons: React still streams Suspense boundaries during
 * ordinary dynamic SSR (this app has several — the header nav, `/me`, `/documents`,
 * `/connect`), so streaming gets their fallbacks painted sooner and improves TTFB; and it is
 * the setting PPR would need the moment `cacheComponents` goes back on. SST reads this build
 * output and sets the server function's invoke mode to RESPONSE_STREAM.
 */
const config = {
  default: {
    override: {
      wrapper: "aws-lambda-streaming",
    },
  },
};

export default config;
