import { parseDataUri } from '@lobechat/model-runtime/utils/uriParser';
import { uuid } from '@lobechat/utils';
import dayjs from 'dayjs';
import { sha256 } from 'js-sha256';

import { fileEnv } from '@/envs/file';
import { lambdaClient } from '@/libs/trpc/client';
import { type FileMetadata, type UploadBase64ToS3Result } from '@/types/files';
import { type FileUploadState, type FileUploadStatus } from '@/types/files/upload';

export const UPLOAD_NETWORK_ERROR = 'NetWorkError';

// Files larger than this go through S3 multipart upload (chunked, resumable)
export const MULTIPART_UPLOAD_THRESHOLD = 100 * 1024 * 1024; // 100MB
export const MULTIPART_CHUNK_SIZE = 10 * 1024 * 1024; // 10MB chunks
const MAX_PARALLEL_UPLOADS = 3;
const PART_UPLOAD_MAX_RETRIES = 3;

/**
 * Generate file storage path metadata for S3-compatible storage
 * @param originalFilename - Original filename
 * @param options - Path generation options
 * @returns Path metadata including date, dirname, filename, and pathname
 */
const generateFilePathMetadata = (
  originalFilename: string,
  options: { directory?: string; pathname?: string } = {},
): {
  date: string;
  dirname: string;
  filename: string;
  pathname: string;
} => {
  // Generate unique filename with UUID prefix and original extension
  const extension = originalFilename.split('.').at(-1);
  const filename = `${uuid()}.${extension}`;

  // Generate timestamp-based directory path
  const date = (Date.now() / 1000 / 60 / 60).toFixed(0);
  const dirname = `${options.directory || fileEnv.NEXT_PUBLIC_S3_FILE_PATH}/${date}`;
  const pathname = options.pathname ?? `${dirname}/${filename}`;

  return {
    date,
    dirname,
    filename,
    pathname,
  };
};

interface UploadFileToS3Options {
  abortController?: AbortController;
  directory?: string;
  filename?: string;
  onNotSupported?: () => void;
  onProgress?: (status: FileUploadStatus, state: FileUploadState) => void;
  pathname?: string;
  skipCheckFileType?: boolean;
}

class UploadService {
  /**
   * uniform upload method for both server and client
   */
  uploadFileToS3 = async (
    file: File,
    { onProgress, directory, pathname, abortController }: UploadFileToS3Options,
  ): Promise<{ data: FileMetadata; success: boolean }> => {
    // Server-side upload logic

    // if is server mode, upload to server s3,

    // Large files go through S3 multipart upload (chunked, parallel, resumable)
    if (file.size > MULTIPART_UPLOAD_THRESHOLD) {
      const data = await this.uploadLargeFileToS3(file, {
        abortController,
        directory,
        onProgress,
        pathname,
      });
      return { data, success: true };
    }

    const data = await this.uploadToServerS3(file, {
      abortController,
      directory,
      onProgress,
      pathname,
    });
    return { data, success: true };
  };

  /**
   * Upload a large file to S3 using multipart upload:
   * splits the file into 10MB chunks, uploads up to 3 chunks in parallel
   * with per-chunk retry, and assembles the final object server-side.
   */
  uploadLargeFileToS3 = async (
    file: File,
    {
      onProgress,
      directory,
      pathname,
      abortController,
    }: {
      abortController?: AbortController;
      directory?: string;
      onProgress?: (status: FileUploadStatus, state: FileUploadState) => void;
      pathname?: string;
    },
  ): Promise<FileMetadata> => {
    const {
      date,
      dirname,
      filename,
      pathname: key,
    } = generateFilePathMetadata(file.name, {
      directory,
      pathname,
    });
    const startTime = Date.now();
    const totalChunks = Math.ceil(file.size / MULTIPART_CHUNK_SIZE);
    const chunkProgress = Array.from({ length: totalChunks }, () => 0);

    const reportProgress = () => {
      const loaded = chunkProgress.reduce((sum, loaded) => sum + loaded, 0);
      const progress = Number(((loaded / file.size) * 100).toFixed(1));
      const speedInByte = loaded / Math.max((Date.now() - startTime) / 1000, 0.001);
      onProgress?.('uploading', {
        // keep it below 100 until the server assembles the final object
        progress: progress === 100 ? 99.9 : progress,
        restTime: speedInByte > 0 ? (file.size - loaded) / speedInByte : 0,
        speed: speedInByte,
      });
    };

    const { uploadId } = await lambdaClient.multipartUpload.initiateMultipartUpload.mutate({
      contentType: file.type || undefined,
      pathname: key,
      totalSize: file.size,
    });

    const throwIfAborted = () => {
      if (abortController?.signal.aborted) throw new Error('Upload cancelled by user');
    };

    try {
      const parts: Array<{ ETag: string; PartNumber: number }> = [];

      // Upload in batches of MAX_PARALLEL_UPLOADS chunks
      for (let batchStart = 0; batchStart < totalChunks; batchStart += MAX_PARALLEL_UPLOADS) {
        throwIfAborted();
        const batch = Array.from(
          { length: Math.min(MAX_PARALLEL_UPLOADS, totalChunks - batchStart) },
          (_, i) => batchStart + i,
        );
        const results = await Promise.all(
          batch.map((index) =>
            this.uploadSinglePart(file, key, uploadId, index, abortController, (loaded) => {
              chunkProgress[index] = loaded;
              reportProgress();
            }),
          ),
        );
        parts.push(...results);
      }

      parts.sort((a, b) => a.PartNumber - b.PartNumber);

      await lambdaClient.multipartUpload.completeMultipartUpload.mutate({
        key,
        parts,
        uploadId,
      });

      onProgress?.('success', {
        progress: 100,
        restTime: 0,
        speed: file.size / Math.max((Date.now() - startTime) / 1000, 0.001),
      });

      return { date, dirname, filename, path: key };
    } catch (error) {
      // Clean up orphaned parts in S3; ignore cleanup failures
      await lambdaClient.multipartUpload.abortMultipartUpload
        .mutate({ key, uploadId })
        .catch(() => undefined);
      if (abortController?.signal.aborted) {
        onProgress?.('cancelled', { progress: 0, restTime: 0, speed: 0 });
        throw new Error('Upload cancelled by user', { cause: error });
      }
      throw error;
    }
  };

  private uploadSinglePart = async (
    file: File,
    key: string,
    uploadId: string,
    index: number,
    abortController: AbortController | undefined,
    onChunkProgress: (loaded: number) => void,
  ): Promise<{ ETag: string; PartNumber: number }> => {
    const partNumber = index + 1; // S3 part numbers are 1-indexed
    const start = index * MULTIPART_CHUNK_SIZE;
    const chunk = file.slice(start, Math.min(start + MULTIPART_CHUNK_SIZE, file.size));
    const chunkSize = chunk.size;

    let lastError: unknown;
    for (let attempt = 0; attempt < PART_UPLOAD_MAX_RETRIES; attempt++) {
      try {
        if (abortController?.signal.aborted) throw new Error('Upload cancelled by user');
        const { url } = await lambdaClient.multipartUpload.getPartUploadUrl.mutate({
          key,
          partNumber,
          uploadId,
        });
        const etag = await this.putPart(url, chunk, abortController, (loaded) => {
          onChunkProgress(Math.min(loaded, chunkSize));
        });
        onChunkProgress(chunkSize);
        return { ETag: etag, PartNumber: partNumber };
      } catch (error) {
        lastError = error;
        if (abortController?.signal.aborted) throw error;
        // Exponential backoff before retrying the same chunk
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
    throw lastError;
  };

  private putPart = (
    url: string,
    chunk: Blob,
    abortController: AbortController | undefined,
    onProgress: (loaded: number) => void,
  ): Promise<string> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      abortController?.signal.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(event.loaded);
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const etag = xhr.getResponseHeader('ETag');
          if (!etag) {
            reject(new Error('Part upload succeeded but ETag header is missing'));
            return;
          }
          resolve(etag);
        } else {
          reject(new Error(xhr.statusText || `Part upload failed with status ${xhr.status}`));
        }
      });
      xhr.addEventListener('error', () => {
        if (xhr.status === 0) reject(UPLOAD_NETWORK_ERROR);
        else reject(new Error(xhr.statusText || 'Part upload failed'));
      });
      xhr.addEventListener('abort', () => reject(new Error('Upload cancelled by user')));
      xhr.open('PUT', url);
      xhr.send(chunk);
    });

  uploadBase64ToS3 = async (
    base64Data: string,
    options: UploadFileToS3Options = {},
  ): Promise<UploadBase64ToS3Result> => {
    // Parse base64 data
    const { base64, mimeType, type } = parseDataUri(base64Data);

    if (!base64 || !mimeType || type !== 'base64') {
      throw new Error('Invalid base64 data for image');
    }

    // Convert base64 to Blob
    const byteCharacters = atob(base64);
    const byteArrays = [];

    // Process in chunks to avoid memory issues
    for (let offset = 0; offset < byteCharacters.length; offset += 1024) {
      const slice = byteCharacters.slice(offset, offset + 1024);

      const byteNumbers: number[] = Array.from({ length: slice.length });
      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i);
      }

      const byteArray = new Uint8Array(byteNumbers);
      byteArrays.push(byteArray);
    }

    const blob = new Blob(byteArrays, { type: mimeType });

    // Determine file extension
    const fileExtension = mimeType.split('/')[1] || 'png';
    const fileName = `${options.filename || `image_${dayjs().format('YYYY-MM-DD-hh-mm-ss')}`}.${fileExtension}`;

    // Create file object
    const file = new File([blob], fileName, { type: mimeType });

    // Use unified upload method
    const { data: metadata } = await this.uploadFileToS3(file, options);
    const hash = sha256(await file.arrayBuffer());

    return {
      fileType: mimeType,
      hash,
      metadata,
      size: file.size,
    };
  };

  uploadDataToS3 = async (data: object, options: UploadFileToS3Options = {}) => {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const file = new File([blob], options.filename || 'data.json', { type: 'application/json' });
    return await this.uploadFileToS3(file, options);
  };

  uploadToServerS3 = async (
    file: File,
    {
      onProgress,
      directory,
      pathname,
      abortController,
    }: {
      abortController?: AbortController;
      directory?: string;
      onProgress?: (status: FileUploadStatus, state: FileUploadState) => void;
      pathname?: string;
    },
  ): Promise<FileMetadata> => {
    const xhr = new XMLHttpRequest();

    const { preSignUrl, ...result } = await this.getSignedUploadUrl(file, { directory, pathname });
    const startTime = Date.now();

    // Setup abort listener
    if (abortController) {
      abortController.signal.addEventListener('abort', () => {
        xhr.abort();
      });
    }

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        const progress = Number(((event.loaded / event.total) * 100).toFixed(1));

        const speedInByte = event.loaded / ((Date.now() - startTime) / 1000);

        onProgress?.('uploading', {
          // if the progress is 100, it means the file is uploaded
          // but the server is still processing it
          // so make it as 99.9 and let users think it's still uploading
          progress: progress === 100 ? 99.9 : progress,
          restTime: (event.total - event.loaded) / speedInByte,
          speed: speedInByte,
        });
      }
    });

    xhr.open('PUT', preSignUrl);
    xhr.setRequestHeader('Content-Type', file.type);
    const data = await file.arrayBuffer();

    await new Promise((resolve, reject) => {
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress?.('success', {
            progress: 100,
            restTime: 0,
            speed: file.size / ((Date.now() - startTime) / 1000),
          });
          resolve(xhr.response);
        } else {
          reject(xhr.statusText);
        }
      });
      xhr.addEventListener('error', () => {
        if (xhr.status === 0) reject(UPLOAD_NETWORK_ERROR);
        else reject(xhr.statusText);
      });
      xhr.addEventListener('abort', () => {
        onProgress?.('cancelled', { progress: 0, restTime: 0, speed: 0 });
        reject(new Error('Upload cancelled by user'));
      });
      xhr.send(data);
    });

    return result;
  };

  private getSignedUploadUrl = async (
    file: File,
    options: { directory?: string; pathname?: string } = {},
  ): Promise<
    FileMetadata & {
      preSignUrl: string;
    }
  > => {
    // Generate file path metadata
    const { date, dirname, filename, pathname } = generateFilePathMetadata(file.name, options);

    const preSignUrl = await lambdaClient.upload.createS3PreSignedUrl.mutate({ pathname });

    return {
      date,
      dirname,
      filename,
      path: pathname,
      preSignUrl,
    };
  };
}

export const uploadService = new UploadService();
