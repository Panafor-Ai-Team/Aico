import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import mime from 'mime';
import { z } from 'zod';

import { fileEnv } from '@/envs/file';
import { YEAR } from '@/utils/units';

import { ensureLocalNoProxyEnv, resolveS3SdkEndpoint } from './localEndpoint';

export const fileSchema = z.object({
  Key: z.string(),
  LastModified: z.date(),
  Size: z.number(),
});

export const listFileSchema = z.array(fileSchema);

export type FileType = z.infer<typeof fileSchema>;

const DEFAULT_S3_REGION = 'us-east-1';
const PUBLIC_READ_ACL_HEADER = 'public-read';

/**
 * RFC 6266 attachment header: an ASCII `filename` fallback plus the UTF-8
 * `filename*` form so non-Latin names (e.g. Persian) survive the download.
 */
export const buildAttachmentContentDisposition = (filename: string): string => {
  const asciiFallback = filename.replaceAll(/[^\u0020-\u007E]/g, '_').replaceAll(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replaceAll(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename="${asciiFallback || 'download'}"; filename*=UTF-8''${encoded}`;
};

export interface PreSignedUpload {
  headers?: Record<string, string>;
  url: string;
}

const createS3Client = (
  accessKeyId: string,
  secretAccessKey: string,
  endpoint: string,
  options?: { forcePathStyle?: boolean; region?: string },
) =>
  new S3Client({
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    endpoint,
    forcePathStyle: options?.forcePathStyle,
    region: options?.region || DEFAULT_S3_REGION,
    // refs: https://github.com/lobehub/lobe-chat/pull/5479
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

export class S3 {
  private readonly client: S3Client;

  private readonly signingClient: S3Client;

  private readonly bucket: string;

  private readonly setAcl: boolean;

  constructor(
    accessKeyId: string | undefined,
    secretAccessKey: string | undefined,
    endpoint: string | undefined,
    options?: {
      bucket?: string;
      forcePathStyle?: boolean;
      region?: string;
      setAcl?: boolean;
      signingEndpoint?: string;
    },
  ) {
    if (!accessKeyId || !secretAccessKey || !endpoint)
      throw new Error('S3 environment variables are not set completely, please check your env');
    if (!options?.bucket) throw new Error('S3 bucket is not set, please check your env');

    this.bucket = options?.bucket;
    this.setAcl = options?.setAcl || false;

    ensureLocalNoProxyEnv();

    const clientOptions = {
      forcePathStyle: options?.forcePathStyle,
      region: options?.region,
    };

    this.client = createS3Client(accessKeyId, secretAccessKey, endpoint, clientOptions);
    this.signingClient =
      options?.signingEndpoint && options.signingEndpoint !== endpoint
        ? createS3Client(accessKeyId, secretAccessKey, options.signingEndpoint, clientOptions)
        : this.client;
  }

  public async deleteFile(key: string) {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return this.client.send(command);
  }

  public async deleteFiles(keys: string[]) {
    const command = new DeleteObjectsCommand({
      Bucket: this.bucket,
      Delete: { Objects: keys.map((key) => ({ Key: key })) },
    });

    return this.client.send(command);
  }

  public async getFileContent(key: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const response = await this.client.send(command);

    if (!response.Body) {
      throw new Error(`No body in response with ${key}`);
    }

    return response.Body.transformToString();
  }

  public async getFileByteArray(key: string): Promise<Uint8Array> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const response = await this.client.send(command);

    if (!response.Body) {
      throw new Error(`No body in response with ${key}`);
    }

    return response.Body.transformToByteArray();
  }

  /**
   * Get file metadata from S3 using HeadObject
   * This is used to verify actual file size from S3 instead of trusting client-provided values
   */
  public async getFileMetadata(
    key: string,
  ): Promise<{ contentLength: number; contentType?: string }> {
    const command = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const response = await this.client.send(command);

    return {
      contentLength: response.ContentLength ?? 0,
      contentType: response.ContentType,
    };
  }

  public async createPreSignedUrl(key: string): Promise<string> {
    const upload = await this.createPreSignedUpload(key);
    return upload.url;
  }

  public async createPreSignedUpload(key: string): Promise<PreSignedUpload> {
    const command = new PutObjectCommand({
      ACL: this.setAcl ? PUBLIC_READ_ACL_HEADER : undefined,
      Bucket: this.bucket,
      Key: key,
    });

    const url = await getSignedUrl(this.signingClient, command, { expiresIn: 3600 });

    return {
      headers: this.setAcl ? { 'x-amz-acl': PUBLIC_READ_ACL_HEADER } : undefined,
      url,
    };
  }

  /**
   * Initiate an S3 multipart upload session for large files.
   * Part numbers are 1-indexed (1 to 10,000); minimum part size is 5MB except the last part.
   */
  public async createMultipartUpload(key: string, contentType?: string): Promise<string> {
    const command = new CreateMultipartUploadCommand({
      ACL: this.setAcl ? PUBLIC_READ_ACL_HEADER : undefined,
      Bucket: this.bucket,
      ContentType: contentType,
      Key: key,
    });

    const response = await this.client.send(command);

    if (!response.UploadId) {
      throw new Error(`Failed to initiate multipart upload for ${key}`);
    }

    return response.UploadId;
  }

  /**
   * Generate a pre-signed URL for uploading a single part (1-hour expiration).
   */
  public async createPartUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      PartNumber: partNumber,
      UploadId: uploadId,
    });

    return getSignedUrl(this.signingClient, command, { expiresIn: 3600 });
  }

  /**
   * Assemble uploaded parts into the final object. ETags must be collected
   * from each part upload response and passed with their 1-indexed part numbers.
   */
  public async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ ETag: string; PartNumber: number }>,
  ): Promise<void> {
    const command = new CompleteMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      MultipartUpload: { Parts: parts },
      UploadId: uploadId,
    });

    await this.client.send(command);
  }

  /**
   * Abort a multipart upload session to clean up orphaned parts in S3.
   */
  public async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const command = new AbortMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
    });

    await this.client.send(command);
  }

  public async createPreSignedUrlForPreview(key: string, expiresIn?: number): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return getSignedUrl(this.signingClient, command, {
      expiresIn: expiresIn ?? fileEnv.S3_PREVIEW_URL_EXPIRE_IN,
    });
  }

  /**
   * Pre-signed GET that makes the browser save the object as `filename`
   * (`Content-Disposition: attachment`) instead of rendering it inline.
   */
  public async createPreSignedUrlForDownload(
    key: string,
    filename: string,
    expiresIn?: number,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: buildAttachmentContentDisposition(filename),
    });

    return getSignedUrl(this.signingClient, command, {
      expiresIn: expiresIn ?? fileEnv.S3_PREVIEW_URL_EXPIRE_IN,
    });
  }

  /**
   * Upload buffer with specified content type
   */
  public async uploadBuffer(
    path: string,
    buffer: Buffer,
    contentType?: string,
    cacheControl?: string,
  ) {
    const command = new PutObjectCommand({
      ACL: this.setAcl ? 'public-read' : undefined,
      Body: buffer,
      Bucket: this.bucket,
      CacheControl: cacheControl,
      ContentType: contentType,
      Key: path,
    });

    return this.client.send(command);
  }

  public async uploadContent(path: string, content: string) {
    const command = new PutObjectCommand({
      ACL: this.setAcl ? 'public-read' : undefined,
      Body: content,
      Bucket: this.bucket,
      Key: path,
    });

    return this.client.send(command);
  }

  /**
   * Upload media file (images only) with long-term cache
   */
  public async uploadMedia(key: string, buffer: Buffer) {
    const contentType = mime.getType(key) || 'application/octet-stream';
    const command = new PutObjectCommand({
      ACL: this.setAcl ? 'public-read' : undefined,
      Body: buffer,
      Bucket: this.bucket,
      CacheControl: `public, max-age=${YEAR}`,
      ContentType: contentType,
      Key: key,
    });

    await this.client.send(command);
  }
}

export class FileS3 extends S3 {
  constructor() {
    const publicEndpoint = fileEnv.S3_ENDPOINT;
    const sdkEndpoint = resolveS3SdkEndpoint(publicEndpoint, fileEnv.S3_INTERNAL_ENDPOINT);

    super(fileEnv.S3_ACCESS_KEY_ID, fileEnv.S3_SECRET_ACCESS_KEY, sdkEndpoint, {
      bucket: fileEnv.S3_BUCKET,
      forcePathStyle: fileEnv.S3_ENABLE_PATH_STYLE,
      region: fileEnv.S3_REGION,
      setAcl: fileEnv.S3_SET_ACL,
      signingEndpoint:
        publicEndpoint && sdkEndpoint && publicEndpoint !== sdkEndpoint
          ? publicEndpoint
          : undefined,
    });
  }
}
