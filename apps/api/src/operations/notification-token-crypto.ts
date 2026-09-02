import { Injectable } from "@nestjs/common";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

@Injectable()
export class NotificationTokenCrypto {
  private readonly keyId = process.env.NOTIFICATION_TOKEN_KEY_ID?.trim() || "local-ephemeral-v1";
  private readonly key = tokenKey();

  encrypt(token: string, userId: string): { encrypted: Uint8Array; keyId: string; hash: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`budgefi:notification:${userId}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return {
      encrypted: Buffer.from(JSON.stringify({ version: 1, iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") }), "utf8"),
      keyId: this.keyId,
      hash: createHash("sha256").update(token).digest("hex"),
    };
  }

  decrypt(value: Uint8Array, keyId: string, userId: string): string {
    if (keyId !== this.keyId) throw new Error("Notification token key is unavailable");
    const envelope = JSON.parse(Buffer.from(value).toString("utf8")) as { version?: unknown; iv?: unknown; ciphertext?: unknown; tag?: unknown };
    if (envelope.version !== 1 || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string" || typeof envelope.tag !== "string") throw new Error("Notification token envelope is malformed");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(`budgefi:notification:${userId}`, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }
}

function tokenKey(): Buffer {
  const configured = process.env.NOTIFICATION_TOKEN_ENCRYPTION_KEY?.trim();
  if (configured) {
    const key = Buffer.from(configured, "base64");
    if (key.length !== 32) throw new Error("NOTIFICATION_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
    return key;
  }
  if (process.env.NODE_ENV === "production") throw new Error("Production push registration requires NOTIFICATION_TOKEN_ENCRYPTION_KEY");
  return randomBytes(32);
}
