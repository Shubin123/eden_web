// SPDX-License-Identifier: GPL-3.0-or-later

self.onmessage = ({ data }) => {
  const control = new Int32Array(data.memory, data.control, 6);
  const position = new BigUint64Array(data.memory, data.control + 16, 1);
  const output = new Uint8Array(data.memory, data.buffer, data.capacity);
  const reader = new FileReaderSync();
  postMessage({ ready: true });
  for (;;) {
    const status = Atomics.load(control, 0);
    if (status !== 1) {
      Atomics.wait(control, 0, status);
      continue;
    }
    try {
      const offset = Number(position[0]);
      const length = control[1];
      if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || length > output.length) {
        throw new Error('Invalid ROM read range');
      }
      const bytes = new Uint8Array(reader.readAsArrayBuffer(data.file.slice(offset, offset + length)));
      output.set(bytes);
      control[2] = bytes.length;
      Atomics.store(control, 0, 2);
    } catch (err) {
      control[2] = -1;
      Atomics.store(control, 0, -1);
      console.error('ROM read failed:', err.message);
    }
    Atomics.notify(control, 0);
  }
};
