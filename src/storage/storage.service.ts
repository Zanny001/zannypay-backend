import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ==========================================
// OBJECT STORAGE — replaces base64-in-Postgres.
//
// Master audit, Critical #2: "Base64 images are stored directly in the
// primary database. User.profileImage and ChatMessage.attachmentData are
// base64 data-URIs in Postgres... Bloats the DB, defeats CDN caching,
// blocks resizing, slows every query touching those tables as volume
// grows. Move to S3/R2/Cloudinary with signed upload URLs."
//
// Design: three adapters behind one interface, chosen by STORAGE_DRIVER.
//   - 's3'    — any S3-compatible bucket (AWS S3, Cloudflare R2,
//               DigitalOcean Spaces, Backblaze B2 via its S3 API). This is
//               the real production path.
//   - 'local' — writes to disk under ./uploads, served statically by this
//               same process (see main.ts). Fine for local dev; not meant
//               for a real multi-instance deployment (no shared disk).
//   - unset / 'none' — passthrough: returns the base64 data URI unchanged.
//               This is the *fallback*, not the target — it exists so a
//               fresh checkout with no cloud credentials configured still
//               runs, instead of crashing on the first profile-photo
//               upload. Every deploy that handles real user data should
//               set STORAGE_DRIVER=s3.
//
// Callers never branch on which adapter is active — user.service.ts and
// support.service.ts just call `storeImage()` with whatever data URI the
// client sent, and get back either a real URL (s3/local) or the original
// data URI back (none). Both are valid values for an <img src> /
// React Native <Image source={{uri}}> — so no downstream rendering code
// in the mobile app or admin dashboard needs to know or care which one
// it received.
// ==========================================

export interface PresignedUpload {
  uploadUrl: string; // where the client PUTs the raw file bytes
  publicUrl: string; // where the file will be readable afterward
  key: string;
  method: 'PUT' | 'LOCAL'; // 'LOCAL' means: POST the base64 body straight to /storage/local-upload/:key instead of a real presigned PUT
}

interface DecodedDataUri {
  buffer: Buffer;
  contentType: string;
  extension: string;
}

const MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly driver = (
    process.env.STORAGE_DRIVER || 'none'
  ).toLowerCase();
  private readonly localUploadsDir = path.join(process.cwd(), 'uploads');
  private s3Client: any = null;
  private warnedAboutPassthroughOnce = false;

  constructor() {
    if (this.driver === 'local' && !fs.existsSync(this.localUploadsDir)) {
      fs.mkdirSync(this.localUploadsDir, { recursive: true });
    }
  }

  private async getS3Client() {
    if (this.s3Client) return this.s3Client;
    // Lazy import: @aws-sdk/client-s3 is a real dependency (see
    // package.json), but importing it eagerly would mean every deploy
    // pays its startup cost even when STORAGE_DRIVER=local/none.
    const { S3Client } = await import('@aws-sdk/client-s3');
    this.s3Client = new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT, // set this for R2/Spaces/B2; leave unset for real AWS S3
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    });
    return this.s3Client;
  }

  private decodeDataUri(dataUri: string): DecodedDataUri | null {
    const match = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/.exec(dataUri);
    if (!match) return null;
    const contentType = match[1];
    const extension = MIME_EXTENSION[contentType] || 'bin';
    return { buffer: Buffer.from(match[2], 'base64'), contentType, extension };
  }

  isDataUri(value?: string | null): boolean {
    return !!value && value.startsWith('data:');
  }

  /**
   * Accepts whatever the client sent (typically a base64 data URI from an
   * image picker) and returns a durable URL. Never throws on a bad input —
   * returns the original value back so a caller can decide how to handle
   * it, since this sits in the middle of money-adjacent request paths
   * (profile update, chat send) that shouldn't hard-fail on a storage
   * hiccup.
   */
  async storeImage(dataUriOrUrl: string, keyPrefix: string): Promise<string> {
    if (!this.isDataUri(dataUriOrUrl)) {
      // Already a URL (either previously migrated, or the client is using
      // the newer presigned-upload flow directly) — nothing to do.
      return dataUriOrUrl;
    }

    const decoded = this.decodeDataUri(dataUriOrUrl);
    if (!decoded) return dataUriOrUrl; // malformed data URI — hand it back rather than losing the upload entirely

    const key = `${keyPrefix}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${decoded.extension}`;

    try {
      if (this.driver === 's3')
        return await this.putToS3(key, decoded.buffer, decoded.contentType);
      if (this.driver === 'local')
        return this.putToLocalDisk(key, decoded.buffer);
    } catch (error) {
      this.logger.error(
        `Failed to upload to ${this.driver} storage, falling back to inline data URI for this request: ${error?.message || error}`,
      );
      return dataUriOrUrl;
    }

    if (!this.warnedAboutPassthroughOnce) {
      this.logger.warn(
        'STORAGE_DRIVER is not set to "s3" or "local" — images are being stored inline as base64 in Postgres. ' +
          'This is a known scaling/PCI-hygiene gap (see master audit, Critical #2). Set STORAGE_DRIVER=s3 with S3_* env vars before handling real user volume.',
      );
      this.warnedAboutPassthroughOnce = true;
    }
    return dataUriOrUrl;
  }

  private async putToS3(
    key: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<string> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getS3Client();
    const bucket = process.env.S3_BUCKET;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );
    return this.publicUrlFor(key);
  }

  private putToLocalDisk(key: string, buffer: Buffer): string {
    const filePath = path.join(this.localUploadsDir, key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
    const base =
      process.env.STORAGE_PUBLIC_BASE_URL ||
      `http://localhost:${process.env.PORT || 10000}`;
    return `${base}/uploads/${key}`;
  }

  private publicUrlFor(key: string): string {
    if (process.env.STORAGE_PUBLIC_BASE_URL)
      return `${process.env.STORAGE_PUBLIC_BASE_URL}/${key}`;
    const bucket = process.env.S3_BUCKET;
    const endpoint = process.env.S3_ENDPOINT;
    if (endpoint) return `${endpoint.replace(/\/$/, '')}/${bucket}/${key}`;
    const region = process.env.S3_REGION || 'us-east-1';
    return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  }

  /**
   * The more scalable path, offered alongside storeImage() rather than
   * instead of it: the client uploads bytes directly to the bucket and
   * never sends a multi-megabyte base64 body through this API at all.
   * Under STORAGE_DRIVER=local there's no real presigned-URL mechanism
   * (nothing else can PUT to this process from outside), so the "upload
   * URL" is this same backend's own upload endpoint instead — the client
   * code path is identical either way, only the destination differs.
   */
  async createPresignedUpload(
    keyPrefix: string,
    contentType: string,
  ): Promise<PresignedUpload> {
    const extension = MIME_EXTENSION[contentType] || 'bin';
    const key = `${keyPrefix}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${extension}`;

    if (this.driver === 's3') {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
      const client = await this.getS3Client();
      const command = new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        ContentType: contentType,
      });
      const uploadUrl = await getSignedUrl(client, command, { expiresIn: 300 });
      return {
        uploadUrl,
        publicUrl: this.publicUrlFor(key),
        key,
        method: 'PUT',
      };
    }

    // local/none: no real presigned URL exists, so the client instead
    // POSTs the file body (base64 JSON, same size cap as everywhere else
    // in this API) to this backend's own /storage/local-upload/:key.
    const base =
      process.env.STORAGE_PUBLIC_BASE_URL ||
      `http://localhost:${process.env.PORT || 10000}`;
    return {
      uploadUrl: `${base}/api/v1/storage/local-upload/${encodeURIComponent(key)}`,
      publicUrl: `${base}/uploads/${key}`,
      key,
      method: 'LOCAL',
    };
  }

  /** Backing implementation for the /storage/local-upload/:key fallback route. */
  saveLocalUploadBody(key: string, dataUri: string): string {
    const decoded = this.decodeDataUri(dataUri);
    if (!decoded) throw new Error('Body must be a base64 data URI.');
    return this.putToLocalDisk(decodeURIComponent(key), decoded.buffer);
  }
}
