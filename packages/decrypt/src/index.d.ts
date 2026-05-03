// @work.books/decrypt — types.

export interface StudioV1View {
  id: string;
  iv: string; // base64url(12 bytes)
  offset: number;
  len: number;
  mac: string; // base64url(16 bytes)
}

export type Envelope =
  | { kind: "plain"; html: string }
  | {
      kind: "studio-v1";
      workbookId: string;
      brokerUrl: string;
      policyHash: string;
      cipher: string;
      views: StudioV1View[];
      payloadB64: string;
    }
  | {
      kind: "age-v1";
      cipherB64: string;
    }
  | { kind: "unsupported"; encryption: string }
  | { kind: "malformed"; encryption: string; reason: string };

export function parseEnvelope(html: string): Envelope;

export function decryptStudioV1(args: {
  envelope: Extract<Envelope, { kind: "studio-v1" }>;
  viewId: string;
  /** Raw 32-byte AES-256 key the broker released (HPKE-unsealed). */
  dek: Uint8Array;
}): Promise<Uint8Array>;

export function decryptAgeV1(args: {
  envelope: Extract<Envelope, { kind: "age-v1" }>;
  passphrase: string;
}): Promise<Uint8Array>;

/** Generate a per-flow X25519 keypair for sealed-DEK transport. */
export function generateTransportKeypair(): Promise<{
  privateKey: CryptoKey;
  pubkeyB64u: string;
}>;

/** HPKE-unseal a DEK the broker returned. */
export function unsealDek(args: {
  sealedDekB64u: string;
  privateKey: CryptoKey;
  workbookId: string;
  viewId: string;
  policyHash: string;
}): Promise<Uint8Array>;
