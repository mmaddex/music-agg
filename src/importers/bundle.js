// Turns one or more uploaded files into an ExportBundle: a flat, read-only list of text files.
// Adapters never care whether the user uploaded a .zip, several .zips, a single .csv, or
// (later) a .tar.gz — they just look at paths and contents.
//
// An upload is { filename, path } (a temp file on disk; the server uses this) or
// { filename, buffer }. Zips on disk are read with random access, so only the entries we keep
// are ever decompressed: a Google Play Music export full of MP3s costs memory only for its CSVs.
//
// ExportBundle { name, files: [{ path, size, text: string }], skipped: [{ path, reason, size? }] }
//
// Zips inside zips are opened too (Apple's privacy export nests three deep); their files get
// the nested archive's path as a prefix, e.g. "outer/inner.zip/data/file.json". Files too
// large to load are skipped and listed in `skipped` instead of failing the whole upload.
//
// To support a new container format (e.g. .tar.gz), add a loader to LOADERS.

import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';

export const LIMITS = {
  maxEntries: 500_000, // entries scanned across all archives in one upload
  maxFiles: 100_000, // text files actually loaded (Google Play Music has one CSV per track)
  maxFileBytes: 100 * 1024 * 1024, // larger text files are skipped, not fatal
  maxArchiveBytes: 300 * 1024 * 1024, // nested zips buffered at once (all levels together); freed after reading
  maxTotalBytes: 500 * 1024 * 1024, // text files kept in memory, after decompression
  maxDepth: 3, // zips inside zips inside zips
};

const ARCHIVE_EXTENSIONS = new Set(['.zip']);

// Only file types an adapter could plausibly read are decompressed.
const TEXT_EXTENSIONS = new Set(['.csv', '.tsv', '.txt', '.json', '.xml', '.m3u', '.m3u8']);

export class BundleError extends Error {}
/** An upload-wide limit was hit: fatal even when it happens inside a nested archive. */
class LimitError extends BundleError {}

/** Decode bytes as text, honouring UTF-8/UTF-16 byte-order marks (iTunes exports are UTF-16). */
export function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

/** macOS resource forks, Finder metadata, hidden files. */
export function isJunkPath(p) {
  const parts = p.split('/');
  const base = parts[parts.length - 1];
  return parts.includes('__MACOSX') || base.startsWith('._') || base === '.DS_Store' || base.startsWith('.');
}

function isZip(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05) && (buf[3] === 0x04 || buf[3] === 0x06);
}

// matches(filename, head): head is the upload's first bytes (enough for magic numbers).
const LOADERS = [
  {
    id: 'zip',
    matches: (filename, head) => isZip(head),
    load: (upload, ctx) => loadZip(upload.buffer ?? { path: upload.path }, ctx),
  },
  {
    id: 'text',
    matches: (filename) => TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase()),
    load: async (upload, ctx) => {
      const size = upload.buffer ? upload.buffer.length : (await stat(upload.path)).size;
      if (size > LIMITS.maxFileBytes) throw new BundleError(`${upload.filename} is too large.`);
      const buf = upload.buffer ?? (await readFile(upload.path));
      addBytes(ctx, buf.length);
      ctx.fileCount += 1;
      return [textFile(path.basename(upload.filename), buf)];
    },
  },
];

async function uploadHead(upload) {
  if (upload.buffer) return upload.buffer.subarray(0, 8);
  const fh = await open(upload.path, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(8), 0, 8, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

const newContext = () => ({ entries: 0, fileCount: 0, total: 0, archiveBytes: 0, skipped: [] });

function addBytes(ctx, n) {
  ctx.total += n;
  if (ctx.total > LIMITS.maxTotalBytes) throw new LimitError('Archive contents are too large.');
}

/** One uploaded file ({ filename, buffer } or { filename, path }) → ExportBundle. */
export async function loadBundle(upload) {
  return loadBundles([upload]);
}

/**
 * Several uploaded files (e.g. "… Part 1 of 2.zip" and "… Part 2 of 2.zip") → one ExportBundle
 * holding all of their files. Size and entry limits apply to the upload as a whole.
 */
export async function loadBundles(uploads) {
  if (!uploads?.length) throw new BundleError('No file uploaded.');
  const ctx = newContext();
  const files = [];
  for (const upload of uploads) {
    const { filename } = upload;
    const head = await uploadHead(upload);
    const loader = LOADERS.find((l) => l.matches(filename, head));
    if (!loader) {
      throw new BundleError(
        uploads.length > 1
          ? `Unsupported file type: ${filename}. Upload .zip exports or .csv files.`
          : 'Unsupported file type. Upload a .zip export or a .csv file.',
      );
    }
    files.push(...(await loader.load(upload, ctx)));
  }
  return { name: uploads.map((u) => u.filename).join(', '), files, skipped: ctx.skipped };
}

const ZIP_OPTIONS = { lazyEntries: true, validateEntrySizes: true, strictFileNames: false };

/** Open a zip from a Buffer, or from { path } on disk (random access, nothing read up front). */
function openZip(source, cb) {
  if (Buffer.isBuffer(source)) yauzl.fromBuffer(source, ZIP_OPTIONS, cb);
  else yauzl.open(source.path, { ...ZIP_OPTIONS, autoClose: true }, cb);
}

/** Read every wanted entry of a zip. Nested zips are opened recursively. */
function loadZip(source, ctx, prefix = '', depth = 0) {
  return new Promise((resolve, reject) => {
    openZip(source, (err, zip) => {
      if (err) return reject(new BundleError(`Could not read zip file: ${err.message}`));
      const files = [];
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(e instanceof BundleError ? e : new BundleError(`Could not read zip file: ${e.message}`));
      };
      const next = () => {
        if (!settled) zip.readEntry();
      };

      zip.on('error', fail);
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(files);
      });
      zip.on('entry', (entry) => {
        ctx.entries += 1;
        if (ctx.entries > LIMITS.maxEntries) return fail(new LimitError('Archive has too many entries.'));
        const name = entry.fileName.replace(/\\/g, '/');
        const fullPath = prefix + name;
        if (name.endsWith('/') || isJunkPath(name)) return next();
        const ext = path.extname(name).toLowerCase();
        const isArchive = ARCHIVE_EXTENSIONS.has(ext);
        if (!isArchive && !TEXT_EXTENSIONS.has(ext)) return next();
        if (isArchive && depth >= LIMITS.maxDepth) {
          ctx.skipped.push({ path: fullPath, reason: 'archive nested too deeply' });
          return next();
        }
        // Nested zips share one budget, so zips inside zips can't each hold maxArchiveBytes.
        const cap = isArchive ? LIMITS.maxArchiveBytes - ctx.archiveBytes : LIMITS.maxFileBytes;
        // Cheap early skip on the declared size; the real size is enforced while reading.
        if (entry.uncompressedSize > cap) {
          ctx.skipped.push({ path: fullPath, reason: 'too large', size: entry.uncompressedSize });
          return next();
        }
        if (!isArchive && ctx.fileCount >= LIMITS.maxFiles) return fail(new LimitError('Archive has too many files.'));

        readEntry(zip, entry, cap, isArchive ? null : ctx)
          .then(async (data) => {
            if (data === null) {
              ctx.skipped.push({ path: fullPath, reason: 'too large' });
            } else if (isArchive) {
              ctx.archiveBytes += data.length;
              try {
                files.push(...(await loadZip(data, ctx, `${fullPath}/`, depth + 1)));
              } catch (e) {
                // Limits are fatal for the whole upload; a single unreadable inner zip is not.
                if (e instanceof LimitError) throw e;
                ctx.skipped.push({ path: fullPath, reason: 'unreadable archive' });
              } finally {
                ctx.archiveBytes -= data.length;
              }
            } else {
              ctx.fileCount += 1;
              files.push(textFile(fullPath, data));
            }
            next();
          })
          .catch(fail);
      });
      zip.readEntry();
    });
  });
}

/**
 * A bundle file. `text` is decoded on each access rather than up front, so a 100 MB CSV that
 * no adapter reads never becomes a ~200 MB JS string. Adapters should read it once per pass.
 */
function textFile(filePath, buf) {
  return {
    path: filePath,
    size: buf.length,
    get text() {
      return decodeText(buf);
    },
    // First few KB only: enough for header sniffing in detect() without decoding a huge file.
    get head() {
      return decodeText(buf.subarray(0, HEAD_BYTES));
    },
  };
}

const HEAD_BYTES = 8 * 1024;

/** The start of a bundle file's text. Works for hand-built bundles ({ path, text }) too. */
export function fileHead(file) {
  return file.head ?? file.text.slice(0, HEAD_BYTES);
}

/**
 * Decompress one entry. Counts real bytes, never the sizes declared in the archive. Resolves
 * null when the entry is over `cap` (the rest is drained, not kept). With `ctx`, the bytes
 * count toward the upload's total (text files); nested zips pass null since they are freed.
 */
function readEntry(zip, entry, cap, ctx) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      // Write straight into one buffer of the declared size rather than collecting chunks and
      // concatenating (which briefly needs twice the memory). yauzl's validateEntrySizes fails
      // the stream if the real size differs from the declared one; the bounds check below
      // makes sure we never write past the buffer either way.
      const out = Buffer.allocUnsafe(Math.min(entry.uncompressedSize, cap));
      let size = 0;
      let over = false;
      stream.on('data', (chunk) => {
        if (over) return;
        if (size + chunk.length > out.length) {
          over = true;
          if (ctx) ctx.total -= size;
          return;
        }
        try {
          if (ctx) addBytes(ctx, chunk.length);
        } catch (e) {
          stream.destroy(e);
          return;
        }
        chunk.copy(out, size);
        size += chunk.length;
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(over ? null : out.subarray(0, size)));
    });
  });
}
