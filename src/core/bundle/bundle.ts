import { unzipSync } from 'fflate';

/**
 * A flat, in-memory view of everything the user uploaded.
 *
 * Exports arrive in different containers — a Google Takeout .zip, a single .csv,
 * possibly a .tar.gz or several zips in the future. Unpackers flatten all of them
 * into one list of files with archive-relative paths, so importers can just look
 * for the paths/headers they recognise without caring how the data was packaged.
 */
export interface BundleFile {
  /** Path inside the bundle using "/" separators, e.g. "Takeout/YouTube and YouTube Music/playlists/Forro.csv". */
  path: string;
  /** Last path segment. */
  name: string;
  size: number;
  bytes: Uint8Array;
}

export interface ExportBundle {
  /** Names of the files the user uploaded (for display). */
  sources: string[];
  files: BundleFile[];
}

export interface UploadedFile {
  name: string;
  data: Uint8Array;
}

/** Turns one uploaded file into zero or more bundle files. */
export interface Unpacker {
  id: string;
  /** Return true if this unpacker understands the file. */
  accepts(file: UploadedFile): boolean;
  unpack(file: UploadedFile, limits: UnpackLimits): BundleFile[];
}

export interface UnpackLimits {
  /** Max total uncompressed bytes across the whole bundle (zip-bomb guard). */
  maxTotalBytes: number;
  /** Max number of files in the bundle. */
  maxFiles: number;
}

export const DEFAULT_LIMITS: UnpackLimits = {
  maxTotalBytes: 1024 * 1024 * 1024,
  maxFiles: 20_000,
};

const textDecoder = new TextDecoder('utf-8');

export function fileText(file: BundleFile): string {
  // Strip a UTF-8 BOM if present.
  const text = textDecoder.decode(file.bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** First line of a text file, without reading/decoding the whole thing. */
export function firstLine(file: BundleFile, maxBytes = 4096): string {
  const head = textDecoder.decode(file.bytes.subarray(0, maxBytes));
  const clean = head.charCodeAt(0) === 0xfeff ? head.slice(1) : head;
  const nl = clean.search(/\r?\n/);
  return nl === -1 ? clean : clean.slice(0, nl);
}

export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/** OS junk that should never be treated as export data. */
export function isJunkPath(path: string): boolean {
  const name = baseName(path);
  return (
    path.split('/').includes('__MACOSX') ||
    name.startsWith('._') ||
    name === '.DS_Store' ||
    name === 'Thumbs.db' ||
    name === 'desktop.ini'
  );
}

function isZip(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && (data[2] === 0x03 || data[2] === 0x05);
}

export const zipUnpacker: Unpacker = {
  id: 'zip',
  accepts: (f) => isZip(f.data),
  unpack(f, limits) {
    let total = 0;
    let count = 0;
    const entries = unzipSync(f.data, {
      filter: (info) => {
        const path = normalizePath(info.name);
        if (!path || info.name.endsWith('/') || isJunkPath(path)) return false;
        count += 1;
        total += info.originalSize;
        if (count > limits.maxFiles) throw new BundleError(`Archive has more than ${limits.maxFiles} files.`);
        if (total > limits.maxTotalBytes) {
          throw new BundleError('Archive is too large when uncompressed.');
        }
        return true;
      },
    });
    const prefix = stripExt(f.name);
    return Object.entries(entries).map(([name, bytes]) => {
      const path = `${prefix}/${normalizePath(name)}`;
      return { path, name: baseName(path), size: bytes.length, bytes };
    });
  },
};

/** Fallback: the upload is itself a data file (e.g. a single CSV). */
export const plainFileUnpacker: Unpacker = {
  id: 'plain',
  accepts: () => true,
  unpack(f) {
    const path = normalizePath(f.name) || 'upload';
    return [{ path, name: baseName(path), size: f.data.length, bytes: f.data }];
  },
};

/**
 * Ordered list; first match wins. To support .tar.gz, .7z, etc. add an unpacker
 * here — nested archives (a zip inside a zip) are expanded automatically.
 */
export const UNPACKERS: Unpacker[] = [zipUnpacker, plainFileUnpacker];

/** "dir/archive.zip" -> "dir/archive" (keeps the directory so nested archives stay distinct). */
function stripExt(name: string): string {
  const path = normalizePath(name) || 'upload';
  const base = baseName(path);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? path.slice(0, path.length - (base.length - dot)) : path;
}

export class BundleError extends Error {}

export function buildBundle(
  uploads: UploadedFile[],
  limits: UnpackLimits = DEFAULT_LIMITS,
  unpackers: Unpacker[] = UNPACKERS,
): ExportBundle {
  const files: BundleFile[] = [];
  const queue: { file: UploadedFile; depth: number }[] = uploads.map((file) => ({ file, depth: 0 }));
  let total = 0;
  while (queue.length) {
    const { file, depth } = queue.shift()!;
    const unpacker = unpackers.find((u) => u.accepts(file))!;
    if (unpacker.id === 'plain' || depth >= 3) {
      if (isJunkPath(normalizePath(file.name))) continue;
      const out = plainFileUnpacker.unpack(file, limits);
      files.push(...out);
      total += file.data.length;
    } else {
      for (const inner of unpacker.unpack(file, limits)) {
        queue.push({ file: { name: inner.path, data: inner.bytes }, depth: depth + 1 });
      }
    }
    if (files.length > limits.maxFiles) throw new BundleError(`Upload has more than ${limits.maxFiles} files.`);
    if (total > limits.maxTotalBytes) throw new BundleError('Upload is too large when uncompressed.');
  }
  return { sources: uploads.map((u) => u.name), files };
}
