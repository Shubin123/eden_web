// SPDX-License-Identifier: GPL-3.0-or-later

async function cacheRom(rom, onProgress) {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle('rom-cache', { create: true });
  const handle = await directory.getFileHandle('game', { create: true });
  const writable = await handle.createWritable();
  let reader;
  let bytes = 0;
  try {
    reader = (await rom.stream()).getReader();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      await writable.write(part.value);
      bytes += part.value.length;
      onProgress(bytes);
    }
    if (rom.size >= 0 && bytes !== rom.size) throw new Error(`${rom.name} is truncated (${bytes} of ${rom.size} bytes)`);
    await writable.close();
    return await handle.getFile();
  } catch (err) {
    await reader?.cancel(err).catch(() => {});
    await writable.abort().catch(() => {});
    throw err;
  } finally {
    reader?.releaseLock();
  }
}

// The engine reads through a small mailbox on its own threads. The UI never waits
// synchronously for disk I/O and never retains the whole decoded game in memory.
export async function mountBrowserRom(module, path, rom, onProgress) {
  const file = rom.file ?? await cacheRom(rom, onProgress);
  const worker = new Worker(new URL('./rom-io-worker.js', import.meta.url), { type: 'module' });
  try {
    const ready = new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.ready && resolve();
      worker.onerror = error => reject(new Error(error.message || 'ROM reader failed to start'));
    });
    if (module.ccall('eden_register_browser_rom', 'number', ['string', 'number'], [path, file.size]) !== 0) {
      throw new Error('The core rejected the ROM file');
    }
    worker.postMessage({
      file,
      memory: module.HEAPF64.buffer,
      control: Number(module._eden_get_rom_io_control()),
      buffer: Number(module._eden_get_rom_io_buffer()),
      capacity: module._eden_get_rom_io_buffer_size(),
    });
    await ready;
    onProgress(file.size);
    return { bytes: file.size, close: () => worker.terminate() };
  } catch (err) {
    worker.terminate();
    throw err;
  }
}
