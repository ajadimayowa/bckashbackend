export interface S3UploadResult {
  key: string;
  /** Only set for adapters that make objects reachable by a stable URL (mock/local) — never a public S3 URL. */
  url?: string;
}

/**
 * Bucket is private by default — no object is ever served by a public URL.
 * Reads always go through `getSignedReadUrl`, a short-lived, single-object
 * pre-signed URL. Never store raw bytes/base64 in Mongo — only the `key`
 * this adapter returns.
 */
export interface S3Adapter {
  upload(key: string, buffer: Buffer, contentType: string): Promise<S3UploadResult>;
  getSignedReadUrl(key: string, expiresInSeconds?: number): Promise<string>;
  delete(key: string): Promise<void>;
}

export const S3_ADAPTER = Symbol('S3_ADAPTER');
