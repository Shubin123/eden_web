// SPDX-License-Identifier: GPL-3.0-or-later
// Checks the per-test time limit of the game suites: work that outlives it is stopped by closing
// the browser's pages, and fails with a time-limit error; work that finishes in time is untouched.

import assert from 'node:assert/strict';
import { MAX_TEST_S, withTimeLimit } from './lib/game-session.mjs';

assert.equal(MAX_TEST_S, 300);

// A fake lab whose single page rejects whatever waits on it once it is closed.
function fakeLab() {
  let fail;
  const waiting = new Promise((_, reject) => { fail = reject; });
  const page = { closed: false, close: async () => { page.closed = true; fail(new Error('Target closed')); } };
  return { lab: { browser: { pages: async () => [page] } }, page, waiting };
}

{
  const { lab, page, waiting } = fakeLab();
  await assert.rejects(withTimeLimit(lab, 0.05, () => waiting), /stopped after the 0\.05 s time limit \(Target closed\)/);
  assert.ok(page.closed, 'the page is closed when the limit expires');
}
{
  const { lab, page } = fakeLab();
  assert.equal(await withTimeLimit(lab, 1, async () => 'done'), 'done');
  await new Promise(r => setTimeout(r, 20));
  assert.ok(!page.closed, 'work that finishes in time leaves the pages open');
}
{
  const { lab } = fakeLab();
  await assert.rejects(withTimeLimit(lab, 1, async () => { throw new Error('boom'); }), /^Error: boom$/);
}
console.log('time limit OK');
