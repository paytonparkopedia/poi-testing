import { createReadStream, createWriteStream, promises as fs } from 'fs';
import { join } from 'path';
import { Readable, Writable } from 'stream';

export interface StorageAdapter {
  saveFile(filePath: string, stream: Readable): Promise<string>;
  getFileStream(filePath: string): Promise<Readable>;
  deleteFile(filePath: string): Promise<void>;
  fileExists(filePath: string): Promise<boolean>;
}

export class LocalStorageAdapter implements StorageAdapter {
  private baseDir: string;

  constructor(baseDir: string = './storage') {
    this.baseDir = baseDir;
  }

  async ensureDir(dir: string): Promise<void> {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  async saveFile(filePath: string, stream: Readable): Promise<string> {
    const fullPath = join(this.baseDir, filePath);
    const dir = join(fullPath, '..');
    await this.ensureDir(dir);

    return new Promise((resolve, reject) => {
      const writeStream = createWriteStream(fullPath);
      stream.pipe(writeStream);
      writeStream.on('finish', () => resolve(fullPath));
      writeStream.on('error', reject);
      stream.on('error', reject);
    });
  }

  async getFileStream(filePath: string): Promise<Readable> {
    const fullPath = join(this.baseDir, filePath);
    return createReadStream(fullPath);
  }

  async deleteFile(filePath: string): Promise<void> {
    const fullPath = join(this.baseDir, filePath);
    try {
      await fs.unlink(fullPath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async fileExists(filePath: string): Promise<boolean> {
    const fullPath = join(this.baseDir, filePath);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }
}

// S3 adapter placeholder (for production)
export class S3StorageAdapter implements StorageAdapter {
  // TODO: Implement S3 adapter using AWS SDK
  async saveFile(filePath: string, stream: Readable): Promise<string> {
    throw new Error('S3 adapter not implemented yet');
  }

  async getFileStream(filePath: string): Promise<Readable> {
    throw new Error('S3 adapter not implemented yet');
  }

  async deleteFile(filePath: string): Promise<void> {
    throw new Error('S3 adapter not implemented yet');
  }

  async fileExists(filePath: string): Promise<boolean> {
    throw new Error('S3 adapter not implemented yet');
  }
}

export function getStorageAdapter(): StorageAdapter {
  const storageType = process.env.STORAGE_TYPE || 'local';
  if (storageType === 's3') {
    return new S3StorageAdapter();
  }
  // Resolve to absolute path to ensure consistent location regardless of working directory
  // If STORAGE_BASE_DIR is set, use it (can be relative or absolute)
  // Otherwise, default to project root/storage
  let baseDir = process.env.STORAGE_BASE_DIR || './storage';
  // If relative path, resolve relative to project root (go up from server/src/storage to project root)
  if (!baseDir.startsWith('/') && baseDir.startsWith('./')) {
    const path = require('path');
    // __dirname is server/src/storage, so go up 3 levels to project root
    const projectRoot = path.resolve(__dirname, '../../../');
    baseDir = path.join(projectRoot, baseDir.substring(2)); // Remove './' prefix
  } else if (!baseDir.startsWith('/')) {
    // Relative path without './' prefix
    const path = require('path');
    const projectRoot = path.resolve(__dirname, '../../../');
    baseDir = path.join(projectRoot, baseDir);
  }
  return new LocalStorageAdapter(baseDir);
}
