import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { PlaidConfig, type PlaidEnvironment } from "./plaid.config.js";

type Envelope = Readonly<{ version: 1; keyId: string; iv: string; ciphertext: string; tag: string }>;
type TokenContext = Readonly<{ environment: PlaidEnvironment; itemId: string; connectionId: string }>;
type LinkTokenContext = Readonly<{ environment: PlaidEnvironment; sessionId: string }>;

@Injectable()
export class PlaidTokenCrypto {
  constructor(@Inject(PlaidConfig) private readonly config: PlaidConfig) {}

  encrypt(token: string, context: TokenContext): { encrypted: Uint8Array; keyId: string } {
    return this.encryptWithAad(token, aad(context));
  }

  encryptPublicToken(token: string, context: LinkTokenContext): { encrypted: Uint8Array; keyId: string } {
    return this.encryptWithAad(token, linkAad(context));
  }

  decryptPublicToken(value: Uint8Array, expectedKeyId: string, context: LinkTokenContext): string {
    return this.decryptWithAad(value, expectedKeyId, linkAad(context));
  }

  private encryptWithAad(token: string, associatedData: Buffer): { encrypted: Uint8Array; keyId: string } {
    const keyId = this.config.activeKeyId;
    const key = this.config.tokenKeys.get(keyId);
    if (!key) throw new Error("Plaid token encryption key is unavailable");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(associatedData);
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    const envelope: Envelope = { version: 1, keyId, iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
    return { encrypted: Buffer.from(JSON.stringify(envelope), "utf8"), keyId };
  }

  decrypt(value: Uint8Array, expectedKeyId: string, context: TokenContext): string {
    return this.decryptWithAad(value, expectedKeyId, aad(context));
  }

  private decryptWithAad(value: Uint8Array, expectedKeyId: string, associatedData: Buffer): string {
    let envelope: Envelope;
    try { envelope = JSON.parse(Buffer.from(value).toString("utf8")) as Envelope; }
    catch { throw new Error("Plaid token envelope is malformed"); }
    if (envelope.version !== 1 || envelope.keyId !== expectedKeyId) throw new Error("Plaid token envelope metadata does not match");
    const key = this.config.tokenKeys.get(envelope.keyId);
    if (!key) throw new Error(`Plaid token key ${envelope.keyId} is unavailable`);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(associatedData);
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
    } catch { throw new Error("Plaid token envelope authentication failed"); }
  }
}

function aad(context: TokenContext): Buffer {
  return Buffer.from(`budgefi:plaid:${context.environment}:${context.itemId}:${context.connectionId}`, "utf8");
}

function linkAad(context: LinkTokenContext): Buffer {
  return Buffer.from(`budgefi:plaid-link:${context.environment}:${context.sessionId}`, "utf8");
}
