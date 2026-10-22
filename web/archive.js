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

// 7z packs file data from byte 32. Archives made with the Copy method ("store") keep the first
// entry there unchanged, so it can be read in place instead of decoded and copied out.
const SEVEN_ZIP_DATA_START = 32;
const VERIFY_BYTES = 1 << 20;

// Total size a PFS0 (NSP) header at the start of `blob` describes, or -1.
async function pfs0Size(blob) {
  const head = new DataView(await blob.slice(0, 16).arrayBuffer());
  if (head.byteLength < 16 || head.getUint32(0, true) !== 0x30534650) return -1;  // "PFS0"
  const count = head.getUint32(4, true);
  const strings = head.getUint32(8, true);
  if (count === 0 || count > 4096) return -1;
  const entries = new DataView(await blob.slice(16, 16 + 24 * count).arrayBuffer());
  if (entries.byteLength < 24 * count) return -1;
  let end = 0;
  for (let i = 0; i < count; ++i) {
    end = Math.max(end, Number(entries.getBigUint64(i * 24, true) + entries.getBigUint64(i * 24 + 8, true)));
  }
  return 16 + 24 * count + strings + end;
}

/// For an NSP stored uncompressed in a 7z, returns a lazy slice of the archive holding it, or
/// null. The slice must start a PFS0 of exactly the entry's size and match the first bytes the
/// decoder produced, so a compressed or differently laid out archive is never misread. Once the
/// comparison has started, rom.stream() is used up whatever the result.
export async function storedRomSlice(file, rom) {
  if (!file.name.toLowerCase().endsWith('.7z') || !rom.name.toLowerCase().endsWith('.nsp') || rom.size <= 0) {
    return null;
  }
  const slice = file.slice(SEVEN_ZIP_DATA_START, SEVEN_ZIP_DATA_START + rom.size);
  if (slice.size !== rom.size || await pfs0Size(slice) !== rom.size) return null;
  const expected = new Uint8Array(await slice.slice(0, Math.min(VERIFY_BYTES, rom.size)).arrayBuffer());
  const reader = (await rom.stream()).getReader();
  try {
    let offset = 0;
    while (offset < expected.length) {
      const { done, value } = await reader.read();
      if (done) return null;
      const length = Math.min(value.length, expected.length - offset);
      for (let i = 0; i < length; ++i) {
        if (value[i] !== expected[offset + i]) return null;
      }
      offset += length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return slice;
}
