import type { StageSettings } from "../config/stages";
import { LOGICAL_NAMES } from "../names";

interface StorageBucketOptions {
  readonly settings: StageSettings;
}

// A general-purpose private S3 bucket, deliberately UNWIRED: no code path reads or writes
// it, the API Lambda has no s3: permission on it, and neither app receives its name. It is
// provisioned now so the stack owns its storage from the start rather than growing a bucket
// out-of-band later.
//
// Defaults inherited from sst.aws.Bucket that matter: all public access is blocked (no
// `access`/`policy` is set), and a bucket policy denies non-TLS requests (`enforceHttps`
// defaults to true). Encryption is SSE-S3, applied by S3 itself to every new bucket. The
// physical name is auto-generated (app-stage-name-hash) so it is globally unique and
// per-stage isolated — operators read it from the `bucket` stack output.
//
// To wire it up later: grant the API Lambda's role the specific s3: actions it needs scoped
// to this bucket's ARN (shared/iam.ts), and pass `bucket.name` into the function's
// environment (services/api.ts). Grant named actions on this ARN — never s3:* on "*".
export function createStorageBucket(options: StorageBucketOptions) {
  const bucket = new sst.aws.Bucket(LOGICAL_NAMES.storageBucket, {
    // Nothing reaches S3 from a browser (SST's default here is a wildcard CORS config).
    // The day something uploads direct-to-S3, replace this with an explicit origin list —
    // and note that bucket CORS is a separate layer from the gateway's (services/gateway.ts).
    cors: false,
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
