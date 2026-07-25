import type { StageSettings } from "../config/stages";
import { LOGICAL_NAMES } from "../names";

// The one key prefix the document API reads and writes, and the only part of the bucket the API
// Lambda is granted access to. Shared by the IAM grant (shared/iam.ts) and the function env
// (services/api.ts) so the permission boundary and the code's idea of where documents live can
// never drift apart. The backend's DocumentKey builds every key beneath it as
// `documents/{clerkUserId}/{documentId}/{filename}`.
export const DOCUMENTS_PREFIX = "documents/";

// How long a browser may cache the preflight for a direct-to-S3 upload. Uploads come in bursts
// (pick several files, PUT each), so caching the OPTIONS saves a round trip per file.
const CORS_MAX_AGE = "1 hour";

interface StorageBucketOptions {
  readonly settings: StageSettings;
}

// The document store. Private, TLS-only, unversioned; the ONLY route to an object is a presigned
// URL minted by the API Lambda, which signs with its own role — so the prefix scope in
// shared/iam.ts still binds even though the browser talks to S3 directly.
//
// Defaults inherited from sst.aws.Bucket that matter: all public access is blocked (no
// `access`/`policy` is set), and a bucket policy denies non-TLS requests (`enforceHttps`
// defaults to true). Encryption is SSE-S3, applied by S3 itself to every new bucket. The
// physical name is auto-generated (app-stage-name-hash) so it is globally unique and
// per-stage isolated — operators read it from the `bucket` stack output.
export function createStorageBucket(options: StorageBucketOptions) {
  const bucket = new sst.aws.Bucket(LOGICAL_NAMES.storageBucket, {
    // Required because uploads go browser → S3 directly (presigned PUT), which is a
    // cross-origin request from the web app's domain. This is a SEPARATE layer from the API
    // Gateway's CORS (services/gateway.ts) — that one governs calls to the API, this one governs
    // calls to S3 — but both read the same stage origin list, so a stage names its browser
    // origins exactly once. That also means assertStageDeployable's prod guard, which refuses to
    // deploy prod with an empty or wildcard list, now protects the bucket too.
    //
    // A wildcard origin is safe on non-prod here specifically because the presigned URL IS the
    // capability: CORS governs which page may issue the request, not who may read the bucket, and
    // without a valid signature S3 rejects the call regardless of origin. No credentials are sent
    // (the signature travels in the query string), so there is no cookie/ambient-authority risk.
    cors: {
      allowOrigins: [...options.settings.corsAllowOrigins],
      // PUT is the upload. GET/HEAD are not needed for the download path — that is a top-level
      // navigation to a presigned URL, which is not a CORS request at all — but they are allowed
      // so a client can also fetch a document's bytes with JS (preview, checksum) without
      // another infra change.
      allowMethods: ["PUT", "GET", "HEAD"],
      // The presigned PUT signs Content-Type, so the browser must send it and the preflight must
      // permit it.
      allowHeaders: ["content-type"],
      // Lets the uploading page read the ETag off the PUT response to verify what S3 stored.
      exposeHeaders: ["ETag"],
      maxAge: CORS_MAX_AGE,
    },
    // Off deliberately: noncurrent versions accumulate and bill silently, which is what the
    // budget alarm exists to catch. If you turn this on, add a matching `lifecycle` rule to
    // expire noncurrent versions.
    versioning: false,
    transform: {
      // SST hardcodes forceDestroy: true, which deletes every object along with the bucket.
      // Ephemeral stages want exactly that; prod does not. The app-level removal: "retain" +
      // protect (config/stages.ts) is the first lock on prod data — this is the second.
      bucket: { forceDestroy: options.settings.stage !== "prod" },
    },
  });

  return Object.freeze({ bucket });
}
