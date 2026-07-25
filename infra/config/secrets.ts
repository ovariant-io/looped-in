import secretManifestData from "./secrets.json";

// One manifest drives both sides of the secret pipeline: scripts/deploy.mjs reads this
// JSON to load values from the per-stage dotenv files into SST (SSM), and createSecrets()
// below declares the matching sst.Secret handles. Adding a secret means one JSON entry +
// one typed handle here; the names must stay in sync with what's already stored in SSM.
export interface SecretDefinition {
  readonly name: string; // SST secret name (SSM)
  readonly app: "backend" | "frontend"; // which app's .env.<stage> file holds the value
  readonly key: string; // the key inside that dotenv file
  readonly required: boolean;
}

function validateSecretManifest(data: unknown): readonly SecretDefinition[] {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("infra/config/secrets.json must be a non-empty array");
  }
  const names = new Set<string>();
  for (const entry of data) {
    const { name, app, key, required } = entry as Partial<SecretDefinition>;
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("secrets.json: every entry needs a non-empty name");
    }
    if (names.has(name)) throw new Error(`secrets.json: duplicate secret name "${name}"`);
    names.add(name);
    if (app !== "backend" && app !== "frontend") {
      throw new Error(`secrets.json: ${name}.app must be "backend" or "frontend"`);
    }
    if (typeof key !== "string" || key.trim() === "") {
      throw new Error(`secrets.json: ${name}.key must be a non-empty dotenv key`);
    }
    if (typeof required !== "boolean") {
      throw new Error(`secrets.json: ${name}.required must be a boolean`);
    }
  }
  return Object.freeze(data as SecretDefinition[]);
}

export const SECRET_MANIFEST = validateSecretManifest(secretManifestData);

// Encrypted in SSM Parameter Store; never committed. Values are loaded per stage by
// scripts/deploy.mjs from backend/.env.<stage> + frontend/.env.<stage>.
export interface InfrastructureSecrets {
  readonly databaseUrl: sst.Secret; // Neon postgresql:// URL (DATABASE_URL)
  readonly clerkAuthority: sst.Secret; // Clerk Frontend API URL (Clerk__Authority)
  readonly clerkAuthorizedParties: sst.Secret; // optional azp allowlist
  readonly clerkPublishableKey: sst.Secret;
  readonly clerkSecretKey: sst.Secret;
}

export function createSecrets(): InfrastructureSecrets {
  const handles = new Map(
    SECRET_MANIFEST.map((definition) => [
      definition.name,
      // Optional secrets get an empty-string fallback so a stage that never set them still
      // deploys; required ones stay unset, and SST fails the deploy naming the missing one.
      definition.required
        ? new sst.Secret(definition.name)
        : new sst.Secret(definition.name, ""),
    ]),
  );
  const get = (name: string): sst.Secret => {
    const handle = handles.get(name);
    if (!handle) throw new Error(`Secret "${name}" is missing from infra/config/secrets.json`);
    return handle;
  };
  return Object.freeze({
    databaseUrl: get("DatabaseUrl"),
    clerkAuthority: get("ClerkAuthority"),
    clerkAuthorizedParties: get("ClerkAuthorizedParties"),
    clerkPublishableKey: get("ClerkPublishableKey"),
    clerkSecretKey: get("ClerkSecretKey"),
  });
}
