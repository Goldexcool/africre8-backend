import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';

/** Every object this API writes or serves lives under this prefix (the bucket is shared with other projects). */
export const KEY_PREFIX = 'africre8/';
export const SIGN_TTL_SECONDS = 300;

/** Cloudflare R2 through its S3-compatible API. Not configured (no keys) means uploads are simply unavailable. */
@Injectable()
export class ObjectStoreService {
  private client?: S3Client;

  get configured() {
    return process.env.OBJECT_STORE_DRIVER === 'r2' && !!process.env.R2_ENDPOINT && !!process.env.R2_BUCKET && !!process.env.R2_ACCESS_KEY_ID && !!process.env.R2_SECRET_ACCESS_KEY;
  }

  private get bucket() {
    return process.env.R2_BUCKET!;
  }

  private s3() {
    this.client ??= new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
      // R2 does not accept the extra checksum headers newer SDK versions add by default.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    return this.client;
  }

  /** A short-lived URL the app PUTs the file to. Content-Type and the exact byte length are part of the signature. */
  presignPut(key: string, contentType: string, size: number) {
    return getSignedUrl(this.s3(), new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: size }), {
      expiresIn: SIGN_TTL_SECONDS,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
  }

  get(key: string) {
    return this.s3().send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
