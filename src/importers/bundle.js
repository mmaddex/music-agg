// Turns an uploaded file into an ExportBundle: a flat, read-only list of text files.
// Adapters never care whether the user uploaded a .zip, a single .csv, or (later) a
// .tar.gz — they just look at paths and contents.
//
// ExportBundle { name, files: [{ path, size, text: string }] }
//
// To support a new container format (e.g. .tar.gz), add a loader to LOADERS.

import path from 'node:path';
import yauzl from 'yauzl';

export const LIMITS = {
  maxEntries: 20_000, // entries scanned in an archive
  maxFiles: 5_000, // text files actually loaded
  maxFileBytes: 50 * 1024 * 1024,
  maxTotalBytes: 300 * 1024 * 1024, // after decompression
};

// Only file types an adapter could plausibly read are decompressed.
const TEXT_EXTENSIONS = new Set(['.csv', '.tsv', '.txt', '.json', '.xml', '.m3u', '.m3u8']);

export class BundleError extends Error {}

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

const LOADERS = [
  {
    id: 'zip',
    matches: (filename, buf) => isZip(buf),
    load: loadZip,
  },
  {
    id: 'text',
    matches: (filename) => TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase()),
    load: async (filename, buf) => {
      if (buf.length > LIMITS.maxFileBytes) throw new BundleError('File is too large.');
      return [{ path: path.basename(filename), size: buf.length, text: decodeText(buf) }];
    },
  },
];

export async function loadBundle({ filename, buffer }) {
  const loader = LOADERS.find((l) => l.matches(filename, buffer));
  if (!loader) {
    throw new BundleError('Unsupported file type. Upload a .zip export or a .csv file.');
  }
  const files = await loader.load(filename, buffer);
  return { name: filename, files };
}

function loadZip(filename, buf) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, validateEntrySizes: true, strictFileNames: false }, (err, zip) => {
      if (err) return reject(new BundleError(`Could not read zip file: ${err.message}`));
      const files = [];
      let entries = 0;
      let total = 0;
      const fail = (e) => {
        zip.close();
        reject(e instanceof BundleError ? e : new BundleError(`Could not read zip file: ${e.message}`));
      };

      zip.on('error', fail);
      zip.on('end', () => resolve(files));
      zip.on('entry', (entry) => {
        entries += 1;
        if (entries > LIMITS.maxEntries) return fail(new BundleError('Archive has too many entries.'));
        const name = entry.fileName.replace(/\\/g, '/');
        const wanted =
          !name.endsWith('/') && !isJunkPath(name) && TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
        if (!wanted) return zip.readEntry();
        if (files.length >= LIMITS.maxFiles) return fail(new BundleError('Archive has too many files.'));

        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return fail(streamErr);
          const chunks = [];
          let size = 0;
          // Count real decompressed bytes; never trust the sizes declared in the archive.
          stream.on('data', (chunk) => {
            size += chunk.length;
            total += chunk.length;
            if (size > LIMITS.maxFileBytes || total > LIMITS.maxTotalBytes) {
              stream.destroy(new BundleError('Archive contents are too large.'));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('error', fail);
          stream.on('end', () => {
            files.push({ path: name, size, text: decodeText(Buffer.concat(chunks)) });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
