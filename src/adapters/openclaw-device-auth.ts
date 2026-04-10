/**
 * OpenClaw device authentication helpers — Ed25519 signing that matches the
 * gateway's buildDeviceAuthPayloadV3 / verifyDeviceSignature in
 * auth-profiles.js.
 *
 * Discovered by reading the live 2026.3.x dist on Railway during M0. Do not
 * change the payload format without verifying against the current gateway
 * source — field order and delimiter matter.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";

/** Ed25519 SPKI prefix: 12 bytes preceding the raw 32-byte public key. */
const ED25519_SPKI_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

export interface DeviceKeyMaterial {
  /** PEM-encoded PKCS8 private key. Store this, never commit it. */
  privateKeyPem: string;
  /** PEM-encoded SPKI public key. Derivable from the private key, cached for convenience. */
  publicKeyPem: string;
  /** Raw 32-byte Ed25519 public key, base64url encoded. What the gateway stores. */
  publicKeyRawBase64Url: string;
  /** SHA-256 hex of the raw public key. The gateway's deviceId. */
  deviceId: string;
}

export function generateDeviceKey(): DeviceKeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const publicKeyPem = publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  return enrichKey({ privateKeyPem, publicKeyPem });
}

export function loadDeviceKey(privateKeyPem: string): DeviceKeyMaterial {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  return enrichKey({ privateKeyPem, publicKeyPem });
}

function enrichKey(base: {
  privateKeyPem: string;
  publicKeyPem: string;
}): DeviceKeyMaterial {
  const publicKey = createPublicKey(base.publicKeyPem);
  const publicKeyRaw = derivePublicKeyRaw(publicKey);
  const publicKeyRawBase64Url = base64UrlEncode(publicKeyRaw);
  const deviceId = createHash("sha256").update(publicKeyRaw).digest("hex");
  return { ...base, publicKeyRawBase64Url, deviceId };
}

/**
 * Ed25519 SPKI DER is 44 bytes: 12-byte prefix + 32-byte raw key.
 * Strip the prefix to get the raw key the gateway stores and signs over.
 */
function derivePublicKeyRaw(publicKey: KeyObject): Buffer {
  const der = publicKey.export({ format: "der", type: "spki" });
  if (der.length !== 44) {
    throw new Error(
      `unexpected Ed25519 SPKI length: ${der.length} (expected 44)`,
    );
  }
  // Sanity check that the prefix matches what the gateway expects.
  if (!ED25519_SPKI_PREFIX.equals(der.subarray(0, 12))) {
    throw new Error("unexpected Ed25519 SPKI prefix");
  }
  return Buffer.from(der.subarray(12));
}

export interface DeviceAuthPayloadInputs {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: readonly string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
  platform: string;
  deviceFamily: string;
}

/** Matches gateway's buildDeviceAuthPayloadV3. */
export function buildDeviceAuthPayloadV3(inputs: DeviceAuthPayloadInputs): string {
  return [
    "v3",
    inputs.deviceId,
    inputs.clientId,
    inputs.clientMode,
    inputs.role,
    inputs.scopes.join(","),
    String(inputs.signedAtMs),
    inputs.token ?? "",
    inputs.nonce,
    normalizeDeviceMetadata(inputs.platform),
    normalizeDeviceMetadata(inputs.deviceFamily),
  ].join("|");
}

/** Matches gateway's normalizeDeviceMetadataForAuth (trim + lowercase ASCII). */
function normalizeDeviceMetadata(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/[A-Z]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) + 32),
  );
}

export function signDeviceAuthPayload(
  privateKeyPem: string,
  payload: string,
): string {
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = cryptoSign(null, Buffer.from(payload, "utf8"), privateKey);
  return base64UrlEncode(signature);
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
