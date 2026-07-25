/**
 * OpenNext configuration for the Looped In frontend (consumed by SST's `Nextjs` component at deploy).
 *
 * Enables AWS Lambda **response streaming** for the Next.js server function. The app runs with
 * `cacheComponents: true` (PPR): the static shell is sent first, then the dynamic, Suspense-wrapped
 * content (e.g. the Clerk auth UI) streams in. OpenNext's default wrapper *buffers* the whole
 * response, which truncates that stream on Lambda — the browser then throws "Connection closed"
 * and the Suspense boundaries never fill in (you see the static shell, e.g. the Looped In logo, but no
 * auth UI).
 *
 * The `aws-lambda-streaming` wrapper makes the server emit a streamed response; SST reads this
 * build output and sets the server Function URL invoke mode to RESPONSE_STREAM.
 */
const config = {
  default: {
    override: {
      wrapper: "aws-lambda-streaming",
    },
  },
};

export default config;
