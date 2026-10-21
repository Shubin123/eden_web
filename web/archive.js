// SPDX-License-Identifier: GPL-3.0-or-later
// Opens 7z, RAR, tar and other compressed archives through the libarchive worker.

// ZIP is listed too: the built-in reader handles stored and deflated ZIPs, and anything it cannot
// read (Deflate64, LZMA, encryption headers) is retried here.
export const ARCHIVE_EXTENSIONS = [
  '.zip', '.7z', '.rar', '.tar', '.tgz', '.tbz', '.tbz2', '.txz', '.tzst', '.gz', '.bz2',
  '.xz', '.lzma', '.zst', '.lz', '.lz4', '.cab', '.cpio',
];

export function isArchive(name) {
  const lower = name.toLowerCase();
  return ARCHIVE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/// Scans `file` for the first entry with one of `romExtensions`. Resolves to
/// `{ rom: { name, size, stream() } }` when one is found (size is -1 if the archive does not
/// record it), and otherwise to `{ system: [{ name, blob }] }` holding every entry with one of
/// `systemExtensions`.
export function openArchive(file, { romExtensions, systemExtensions }) {
  const worker = new Worker(new URL('./archive-worker.js', import.meta.url), { type: 'module' });
  let pending = null;
  let failure = null;
  const fail = (err) => {
    failure = err;
    worker.terminate();
    pending?.reject(err);
    pending = null;
  };
  const next = () => failure ? Promise.reject(failure)
    : new Promise((resolve, reject) => { pending = { resolve, reject }; });

  worker.onerror = (e) => fail(new Error(e.message || 'the archive worker failed to start'));
  worker.onmessage = ({ data }) => {
    if (data.type === 'error') {
      fail(new Error(`${file.name}: ${data.message}`));
      return;
    }
    const p = pending;
    pending = null;
    p?.resolve(data);
  };

  const ready = next();
  return (async () => {
    // The worker loads the decoder before it listens, so wait until it says it is ready.
    await ready;
    const opened = next();
    worker.postMessage({ type: 'open', file, romExtensions, systemExtensions });
    const result = await opened;
    if (result.type === 'system') {
      worker.terminate();
      return { system: result.entries };
    }
    const stream = new ReadableStream({
      async pull(controller) {
        const chunk = next();
        worker.postMessage({ type: 'pull' });
        const { data } = await chunk;
        if (data.length === 0) {
          worker.terminate();
          controller.close();
        } else {
          controller.enqueue(data);
        }
      },
      cancel() {
        worker.terminate();
      },
    }, { highWaterMark: 2 });
    return { rom: { name: result.name, size: result.size, stream: async () => stream, cancel: () => stream.cancel() } };
  })();
}
