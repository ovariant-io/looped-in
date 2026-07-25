import { auth } from "@clerk/nextjs/server";

/**
 * The server-side seam to the .NET API — the one place the frontend calls it.
 *
 * Every call reads the Clerk session token on the **server** and sends it over `BACKEND_URL` —
 * the Compose network locally, the API Gateway endpoint on AWS. That means no CORS to
 * configure and the token never reaches the browser. The only request the browser makes to
 * anything other than this app is the direct PUT/GET to S3, and then only via a presigned URL
 * that grants access to exactly one object for a few minutes.
 *
 * Lives under `app/lib/` rather than beside one feature because both `/me` and `/documents`
 * call the API and the two had drifted into separate copies of the same fetch, error parsing,
 * and connection-refused diagnostics.
 */

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:5114";

/**
 * Result of a backend call. Returned rather than thrown so callers can render a specific
 * message instead of tripping the error boundary — and so `status` survives the server→client
 * hop for the cases the UI treats differently (0 = unreachable, 401 = token rejected,
 * 503 = a dependency is unconfigured).
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

type CallOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
};

export async function callBackend<T>(
  path: string,
  options: CallOptions = {},
): Promise<ApiResult<T>> {
  const { getToken } = await auth();
  const token = await getToken();

  // Defense in depth: proxy.ts already redirects signed-out users to sign-in, and the API
  // rejects an unauthenticated call anyway.
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "You don't have an active session. Try signing in again.",
    };
  }

  const hasBody = options.body !== undefined;

  let response: Response;
  try {
    response = await fetch(`${BACKEND_URL}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      body: hasBody ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, status: 0, error: describeTransportFailure(err) };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, error: await readError(response) };
  }

  // 204 from DELETE — there is no body to parse.
  if (response.status === 204) {
    return { ok: true, data: undefined as T };
  }

  return { ok: true, data: (await response.json()) as T };
}

/** The base URL calls are made against — for error messages that name the address tried. */
export function backendUrl(): string {
  return BACKEND_URL;
}

/**
 * Turns a fetch rejection into something actionable. A refused connection is overwhelmingly
 * the "backend isn't running" case during local development, so it gets the specific hint
 * rather than a bare TypeError.
 */
function describeTransportFailure(err: unknown): string {
  const cause =
    err instanceof Error && err.cause ? (err.cause as { code?: string }) : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const refused = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(
    `${message} ${cause?.code ?? ""}`,
  );

  if (refused) {
    return (
      `Could not reach the backend at ${BACKEND_URL}. Start it with the http profile ` +
      "(dotnet run --project LoopedIn.Api --launch-profile http) or point BACKEND_URL at it."
    );
  }

  const detail = cause?.code ? `${message} (${cause.code})` : message;
  return `Could not reach the backend at ${BACKEND_URL}: ${detail}`;
}

/**
 * Pulls the human-readable part out of an error response. The API answers with RFC 7807
 * problem+json, whose `detail` is written to be shown to a person — these are the messages that
 * explain an unconfigured bucket or a rejected filename, so surfacing them verbatim is the
 * whole point.
 */
async function readError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) {
      return `The backend returned HTTP ${response.status}.`;
    }

    try {
      const problem = JSON.parse(text) as { detail?: string; title?: string };
      const detail = problem.detail ?? problem.title;
      if (detail) {
        return detail;
      }
    } catch {
      // Not JSON — fall through to the raw text.
    }

    return text.slice(0, 400);
  } catch {
    return `The backend returned HTTP ${response.status}.`;
  }
}
