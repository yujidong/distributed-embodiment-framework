/**
 * Configuration Storage
 *
 * Manages persistent storage of configuration files on the file system.
 * Supports JSON and YAML formats with atomic writes and backup.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DeclarativeConfig } from './types';

import { createLogger } from '@active-collaboration/shared';
const logger = createLogger('ConfigStorage');

export interface StorageOptions {
  configDir: string;
  backupDir?: string;
  maxBackups?: number;
}

export interface ConfigMetadata {
  filename: string;
  path: string;
  size: number;
  createdAt: Date;
  modifiedAt: Date;
  checksum: string;
}

/**
 * Configuration file storage manager
 */
export class ConfigStorage {
  private configDir: string;
  private backupDir: string;
  private maxBackups: number;

  constructor(options: StorageOptions) {
    this.configDir = path.resolve(options.configDir);
    this.backupDir = options.backupDir
      ? path.resolve(options.backupDir)
      : path.join(this.configDir, '.backups');
    this.maxBackups = options.maxBackups ?? 10;
  }

  /**
   * Initialize storage directories
   */
  async initialize(): Promise<void> {
    await fs.promises.mkdir(this.configDir, { recursive: true });
    await fs.promises.mkdir(this.backupDir, { recursive: true });

    // Create subdirectories
    const subdirs = ['environments', 'templates', 'rules'];
    for (const subdir of subdirs) {
      await fs.promises.mkdir(path.join(this.configDir, subdir), { recursive: true });
    }
  }

  /**
   * Save configuration to file
   */
  async save(
    config: DeclarativeConfig,
    filename: string,
    category: 'environments' | 'templates' | 'rules' = 'environments',
    format: 'json' | 'yaml' = 'json'
  ): Promise<string> {
    const dir = path.join(this.configDir, category);
    await fs.promises.mkdir(dir, { recursive: true });

    // Ensure correct extension
    const ext = format === 'yaml' ? '.yaml' : '.json';
    const finalFilename = filename.endsWith(ext) ? filename : `${filename}${ext}`;
    const filePath = path.join(dir, finalFilename);

    // Create backup if file exists
    if (fs.existsSync(filePath)) {
      await this.createBackup(filePath);
    }

    // Serialize content
    let content: string;
    if (format === 'yaml') {
      try {
        const yaml = await import('js-yaml');
        content = yaml.dump(config, {
          indent: 2,
          lineWidth: -1,
          noRefs: true,
          sortKeys: true,
        });
      } catch {
        // Fall back to JSON if YAML not available
        content = JSON.stringify(config, null, 2);
      }
    } else {
      content = JSON.stringify(config, null, 2);
    }

    // Write atomically (write to temp, then rename)
    const tempPath = `${filePath}.tmp`;
    await fs.promises.writeFile(tempPath, content, 'utf-8');
    await fs.promises.rename(tempPath, filePath);

    return filePath;
  }

  /**
   * Load configuration from file
   */
  async load(
    filename: string,
    category: 'environments' | 'templates' | 'rules' = 'environments'
  ): Promise<DeclarativeConfig> {
    const filePath = this.resolvePath(filename, category);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Configuration file not found: ${filePath}`);
    }

    const content = await fs.promises.readFile(filePath, 'utf-8');
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.yaml' || ext === '.yml') {
      try {
        const yaml = await import('js-yaml');
        return yaml.load(content) as DeclarativeConfig;
      } catch {
        // Fall back to simple parsing
        return this.parseSimpleYaml(content);
      }
    }

    return JSON.parse(content) as DeclarativeConfig;
  }

  /**
   * List all configuration files in a category
   */
  async list(
    category: 'environments' | 'templates' | 'rules' = 'environments'
  ): Promise<ConfigMetadata[]> {
    const dir = path.join(this.configDir, category);

    if (!fs.existsSync(dir)) {
      return [];
    }

    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const configs: ConfigMetadata[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (ext !== '.json' && ext !== '.yaml' && ext !== '.yml') continue;

      const filePath = path.join(dir, entry.name);
      const stats = await fs.promises.stat(filePath);

      configs.push({
        filename: entry.name,
        path: filePath,
        size: stats.size,
        createdAt: stats.birthtime,
        modifiedAt: stats.mtime,
        checksum: await this.computeChecksum(filePath),
      });
    }

    return configs.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  }

  /**
   * Delete a configuration file
   */
  async delete(
    filename: string,
    category: 'environments' | 'templates' | 'rules' = 'environments'
  ): Promise<void> {
    const filePath = this.resolvePath(filename, category);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Configuration file not found: ${filePath}`);
    }

    // Create backup before deletion
    await this.createBackup(filePath);

    // Delete file
    await fs.promises.unlink(filePath);
  }

  /**
   * Check if a configuration file exists
   */
  exists(
    filename: string,
    category: 'environments' | 'templates' | 'rules' = 'environments'
  ): boolean {
    const filePath = this.resolvePath(filename, category);
    return fs.existsSync(filePath);
  }

  /**
   * Get configuration file metadata
   */
  async getMetadata(
    filename: string,
    category: 'environments' | 'templates' | 'rules' = 'environments'
  ): Promise<ConfigMetadata | null> {
    const filePath = this.resolvePath(filename, category);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const stats = await fs.promises.stat(filePath);

    return {
      filename,
      path: filePath,
      size: stats.size,
      createdAt: stats.birthtime,
      modifiedAt: stats.mtime,
      checksum: await this.computeChecksum(filePath),
    };
  }

  /**
   * Copy configuration file
   */
  async copy(
    sourceFilename: string,
    targetFilename: string,
    category: 'environments' | 'templates' | 'rules' = 'environments'
  ): Promise<string> {
    const sourcePath = this.resolvePath(sourceFilename, category);
    const targetPath = this.resolvePath(targetFilename, category);

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source configuration not found: ${sourcePath}`);
    }

    await fs.promises.copyFile(sourcePath, targetPath);
    return targetPath;
  }

  /**
   * Rename configuration file
   */
  async rename(
    oldFilename: string,
    newFilename: string,
    category: 'environments' | 'templates' | 'rules' = 'environments'
  ): Promise<string> {
    const oldPath = this.resolvePath(oldFilename, category);
    const newPath = this.resolvePath(newFilename, category);

    if (!fs.existsSync(oldPath)) {
      throw new Error(`Configuration not found: ${oldPath}`);
    }

    // Create backup before rename
    await this.createBackup(oldPath);

    await fs.promises.rename(oldPath, newPath);
    return newPath;
  }

  /**
   * Get backup list for a configuration
   */
  async getBackups(
    filename: string,
    category: 'environments' | 'templates' | 'rules' = 'environments'
  ): Promise<ConfigMetadata[]> {
    const baseName = path.basename(filename, path.extname(filename));
    const backupPattern = new RegExp(`^${baseName}\\.\\d{4}-\\d{2}-\\d{2}T\\d{6}`);

    const categoryBackupDir = path.join(this.backupDir, category);
    if (!fs.existsSync(categoryBackupDir)) {
      return [];
    }

    const entries = await fs.promises.readdir(categoryBackupDir, { withFileTypes: true });
    const backups: ConfigMetadata[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !backupPattern.test(entry.name)) continue;

      const filePath = path.join(categoryBackupDir, entry.name);
      const stats = await fs.promises.stat(filePath);

      backups.push({
        filename: entry.name,
        path: filePath,
        size: stats.size,
        createdAt: stats.birthtime,
        modifiedAt: stats.mtime,
        checksum: await this.computeChecksum(filePath),
      });
    }

    return backups.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  }

  /**
   * Restore configuration from backup
   */
  async restoreBackup(
    backupFilename: string,
    category: 'environments' | 'templates' | 'rules' = 'environments'
  ): Promise<string> {
    const backupPath = path.join(this.backupDir, category, backupFilename);

    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup not found: ${backupPath}`);
    }

    // Extract original filename from backup name
    // Format: filename.YYYY-MM-DDTHHMMSS.ext
    const match = backupFilename.match(/^(.+)\\.\\d{4}-\\d{2}-\\d{2}T\\d{6}\\.(.+)$/);
    if (!match) {
      throw new Error(`Invalid backup filename format: ${backupFilename}`);
    }

    const originalFilename = `${match[1]}.${match[2]}`;
    const targetPath = path.join(this.configDir, category, originalFilename);

    // Create backup of current file if exists
    if (fs.existsSync(targetPath)) {
      await this.createBackup(targetPath);
    }

    await fs.promises.copyFile(backupPath, targetPath);
    return targetPath;
  }

  /**
   * Clean old backups (keep only maxBackups most recent)
   */
  async cleanOldBackups(
    category?: 'environments' | 'templates' | 'rules'
  ): Promise<number> {
    let deleted = 0;

    const categories = category
      ? [category]
      : ['environments', 'templates', 'rules'] as const;

    for (const cat of categories) {
      const categoryBackupDir = path.join(this.backupDir, cat);
      if (!fs.existsSync(categoryBackupDir)) continue;

      // Group backups by original filename
      const entries = await fs.promises.readdir(categoryBackupDir, { withFileTypes: true });
      const backupGroups = new Map<string, string[]>();

      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const match = entry.name.match(/^(.+)\\.\\d{4}-\\d{2}-\\d{2}T\\d{6}\\.(.+)$/);
        if (match) {
          const key = `${match[1]}.${match[2]}`;
          if (!backupGroups.has(key)) {
            backupGroups.set(key, []);
          }
          backupGroups.get(key)!.push(entry.name);
        }
      }

      // Delete old backups for each group
      for (const [, backups] of backupGroups) {
        // Sort by name (contains timestamp) descending
        backups.sort().reverse();

        // Delete backups beyond maxBackups
        for (let i = this.maxBackups; i < backups.length; i++) {
          const backupPath = path.join(categoryBackupDir, backups[i]);
          await fs.promises.unlink(backupPath);
          deleted++;
        }
      }
    }

    return deleted;
  }

  /**
   * Export all configurations as a single JSON object
   * Note: For ZIP archive support, install archiver package
   */
  async exportAll(): Promise<{ [filename: string]: DeclarativeConfig }> {
    const result: { [filename: string]: DeclarativeConfig } = {};

    const categories = ['environments', 'templates', 'rules'] as const;

    for (const category of categories) {
      const configs = await this.list(category);
      for (const configMeta of configs) {
        try {
          const config = await this.load(configMeta.filename, category);
          result[`${category}/${configMeta.filename}`] = config;
        } catch (error) {
          logger.warn(`Failed to load config ${configMeta.filename}:`, error);
        }
      }
    }

    return result;
  }

  // ============================================================
  // Private Methods
  // ============================================================

  /**
   * Resolve file path with extension guessing
   */
  private resolvePath(
    filename: string,
    category: 'environments' | 'templates' | 'rules'
  ): string {
    const dir = path.join(this.configDir, category);

    // If filename has extension, use as-is
    if (path.extname(filename)) {
      return path.join(dir, filename);
    }

    // Try .json first, then .yaml
    const jsonPath = path.join(dir, `${filename}.json`);
    if (fs.existsSync(jsonPath)) {
      return jsonPath;
    }

    const yamlPath = path.join(dir, `${filename}.yaml`);
    if (fs.existsSync(yamlPath)) {
      return yamlPath;
    }

    // Return default (json) path
    return jsonPath;
  }

  /**
   * Create backup of a file
   */
  private async createBackup(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    const category = path.basename(dir);
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);

    const timestamp = new Date().toISOString()
      .replace(/[:.]/g, '')
      .replace('T', 'T')
      .substring(0, 17);

    const backupName = `${baseName}.${timestamp}${ext}`;
    const backupPath = path.join(this.backupDir, category, backupName);

    await fs.promises.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.promises.copyFile(filePath, backupPath);
  }

  /**
   * Compute file checksum
   */
  private async computeChecksum(filePath: string): Promise<string> {
    const crypto = await import('crypto');
    const content = await fs.promises.readFile(filePath);
    return crypto.createHash('md5').update(content).digest('hex');
  }

  /**
   * Simple YAML parser fallback
   */
  private parseSimpleYaml(content: string): DeclarativeConfig {
    // Very basic YAML to JSON conversion
    // For production, use js-yaml library
    const lines = content.split('\n');
    const result: any = {};
    let currentKey = '';
    let currentObj: any = result;
    const stack: any[] = [result];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const indent = line.search(/\S/);

      // Pop stack based on indent
      while (stack.length > 1 && indent <= (stack.length - 1) * 2) {
        stack.pop();
        currentObj = stack[stack.length - 1];
      }

      if (trimmed.includes(':')) {
        const [key, ...valueParts] = trimmed.split(':');
        const value = valueParts.join(':').trim();

        if (value) {
          // Key-value pair
          currentObj[key.trim()] = this.parseValue(value);
        } else {
          // Nested object
          currentObj[key.trim()] = {};
          currentObj = currentObj[key.trim()];
          stack.push(currentObj);
        }
      }
    }

    return result as DeclarativeConfig;
  }

  /**
   * Parse a value string to appropriate type
   */
  private parseValue(value: string): any {
    if (value.startsWith('"') && value.endsWith('"')) {
      return value.slice(1, -1);
    }
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    if (!isNaN(Number(value))) return Number(value);
    return value;
  }
}
