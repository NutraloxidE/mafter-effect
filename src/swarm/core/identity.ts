export interface DeviceIdentity {
  deviceId: string;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
  createdAt: number;
}

export interface IdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const IDENTITY_STORAGE_KEY = "mafter-render-swarm-identity-v1";

function randomId(prefix: string): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  return randomUuid ? `${prefix}-${randomUuid.call(globalThis.crypto)}` : `${prefix}-${Date.now()}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function base64ToBytes(value: string): Uint8Array {
  const text = atob(value);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}

export async function createDeviceIdentity(): Promise<DeviceIdentity> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const [publicKeyJwk, privateKeyJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", keyPair.publicKey),
    crypto.subtle.exportKey("jwk", keyPair.privateKey),
  ]);
  return {
    deviceId: randomId("device"),
    publicKeyJwk,
    privateKeyJwk,
    createdAt: Date.now(),
  };
}

export async function loadOrCreateDeviceIdentity(storage: IdentityStorage): Promise<DeviceIdentity> {
  try {
    const raw = storage.getItem(IDENTITY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DeviceIdentity>;
      if (typeof parsed.deviceId === "string" && parsed.publicKeyJwk && parsed.privateKeyJwk) {
        return parsed as DeviceIdentity;
      }
    }
  } catch {
    /* regenerate a corrupt or unavailable record */
  }
  const identity = await createDeviceIdentity();
  try {
    storage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(identity));
  } catch {
    /* session can still operate without persistence */
  }
  return identity;
}

export async function signChallenge(identity: DeviceIdentity, nonce: string): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    identity.privateKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(nonce),
  );
  return bytesToBase64(new Uint8Array(signature));
}

export async function verifyChallenge(
  publicKeyJwk: JsonWebKey,
  nonce: string,
  signatureBase64: string,
): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      publicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      base64ToBytes(signatureBase64) as unknown as BufferSource,
      new TextEncoder().encode(nonce),
    );
  } catch {
    return false;
  }
}

export function createChallengeNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

export function identityStorageKey(): string {
  return IDENTITY_STORAGE_KEY;
}
