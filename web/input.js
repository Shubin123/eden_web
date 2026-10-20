// SPDX-License-Identifier: GPL-3.0-or-later
// Controller input: keyboard, the on-screen Joy-Cons and browser gamepads, sent to the engine's
// virtual gamepad for player 1.

/// VirtualGamepad::VirtualButton ids in the engine.
export const Button = {
  A: 0, B: 1, X: 2, Y: 3, LStick: 4, RStick: 5, L: 6, R: 7, ZL: 8, ZR: 9,
  Plus: 10, Minus: 11, Left: 12, Up: 13, Right: 14, Down: 15, Home: 18, Capture: 19,
};
const Stick = { Left: 0, Right: 1 };

const KEY_BUTTONS = {
  KeyA: Button.A, KeyS: Button.B, KeyX: Button.X, KeyZ: Button.Y,
  KeyQ: Button.L, KeyE: Button.R, Digit1: Button.ZL, Digit3: Button.ZR,
  Enter: Button.Plus, Backspace: Button.Minus,
  KeyT: Button.Up, KeyG: Button.Down, KeyF: Button.Left, KeyH: Button.Right,
};
// [stick, x, y] for each direction key; +y is up.
const KEY_STICKS = {
  ArrowUp: [Stick.Left, 0, 1], ArrowDown: [Stick.Left, 0, -1],
  ArrowLeft: [Stick.Left, -1, 0], ArrowRight: [Stick.Left, 1, 0],
  KeyI: [Stick.Right, 0, 1], KeyK: [Stick.Right, 0, -1],
  KeyJ: [Stick.Right, -1, 0], KeyL: [Stick.Right, 1, 0],
};
// Standard gamepad mapping, by position: the bottom face button is the Switch's B.
const PAD_BUTTONS = [
  Button.B, Button.A, Button.Y, Button.X, Button.L, Button.R, Button.ZL, Button.ZR,
  Button.Minus, Button.Plus, Button.LStick, Button.RStick,
  Button.Up, Button.Down, Button.Left, Button.Right, Button.Home,
];
const PAD_DEADZONE = 0.12;

const BUTTON_SELECTORS = {
  [Button.A]: '.abxy-btn.btn-a', [Button.B]: '.abxy-btn.btn-b',
  [Button.X]: '.abxy-btn.btn-x', [Button.Y]: '.abxy-btn.btn-y',
  [Button.Up]: '.dpad-btn.up', [Button.Down]: '.dpad-btn.down',
  [Button.Left]: '.dpad-btn.left', [Button.Right]: '.dpad-btn.right',
  [Button.Plus]: '.btn-plus', [Button.Minus]: '.btn-minus',
  [Button.Home]: '.btn-home', [Button.Capture]: '.btn-capture',
};
const STICK_SELECTORS = ['.stick-left', '.stick-right'];

/// `getModule` returns the Emscripten module once a game is running, else null.
export function setupInput(getModule) {
  // Each source holds its own pressed buttons and stick vectors; the engine sees their union.
  const sources = new Map();
  const sent = { buttons: new Set(), sticks: [[0, 0], [0, 0]] };

  function source(name) {
    if (!sources.has(name)) sources.set(name, { buttons: new Set(), sticks: [[0, 0], [0, 0]] });
    return sources.get(name);
  }

  function flush() {
    const buttons = new Set();
    const sticks = [[0, 0], [0, 0]];
    for (const state of sources.values()) {
      state.buttons.forEach(button => buttons.add(button));
      state.sticks.forEach(([x, y], i) => { sticks[i][0] += x; sticks[i][1] += y; });
    }
    const module = getModule();
    for (const button of new Set([...buttons, ...sent.buttons])) {
      const pressed = buttons.has(button);
      if (pressed === sent.buttons.has(button)) continue;
      module?._eden_set_button(0, button, pressed ? 1 : 0);
      document.querySelector(BUTTON_SELECTORS[button])?.classList.toggle('pressed', pressed);
    }
    sent.buttons = buttons;
    sticks.forEach(([x, y], i) => {
      const length = Math.hypot(x, y);
      if (length > 1) { x /= length; y /= length; }
      if (x === sent.sticks[i][0] && y === sent.sticks[i][1]) return;
      sent.sticks[i] = [x, y];
      module?._eden_set_stick(0, i, x, y);
      const knob = document.querySelector(STICK_SELECTORS[i]);
      if (knob) {
        knob.style.translate = x || y ? `${x * 25}% ${-y * 25}%` : '';
        knob.classList.toggle('pressed', Boolean(x || y));
      }
    });
  }

  // Keyboard. Ignored while typing in a form field.
  const keyboard = source('keyboard');
  const heldKeys = new Set();
  function updateKeyboard() {
    keyboard.buttons = new Set([...heldKeys].map(code => KEY_BUTTONS[code]).filter(b => b !== undefined));
    keyboard.sticks = [[0, 0], [0, 0]];
    for (const code of heldKeys) {
      const direction = KEY_STICKS[code];
      if (direction) {
        keyboard.sticks[direction[0]][0] += direction[1];
        keyboard.sticks[direction[0]][1] += direction[2];
      }
    }
    flush();
  }
  const isTyping = target => target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));
  window.addEventListener('keydown', e => {
    if (e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return;
    if (!(e.code in KEY_BUTTONS) && !(e.code in KEY_STICKS)) return;
    e.preventDefault();
    if (!e.repeat) { heldKeys.add(e.code); updateKeyboard(); }
  });
  window.addEventListener('keyup', e => {
    if (heldKeys.delete(e.code)) updateKeyboard();
  });
  window.addEventListener('blur', () => { heldKeys.clear(); updateKeyboard(); });

  // On-screen buttons: press while a pointer is down on them.
  const pointer = source('pointer');
  for (const [button, selector] of Object.entries(BUTTON_SELECTORS)) {
    const element = document.querySelector(selector);
    if (!element) continue;
    const release = () => { pointer.buttons.delete(Number(button)); flush(); };
    element.addEventListener('pointerdown', e => {
      e.preventDefault();
      element.setPointerCapture(e.pointerId);
      pointer.buttons.add(Number(button));
      flush();
    });
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
  }
  // On-screen sticks: drag from the stick's centre.
  STICK_SELECTORS.forEach((selector, stick) => {
    const element = document.querySelector(selector);
    if (!element) return;
    let origin = null;
    const move = e => {
      if (!origin) return;
      const reach = Math.max(element.offsetWidth, 24);
      pointer.sticks[stick] = [(e.clientX - origin.x) / reach, -(e.clientY - origin.y) / reach];
      flush();
    };
    const release = () => { origin = null; pointer.sticks[stick] = [0, 0]; flush(); };
    element.addEventListener('pointerdown', e => {
      e.preventDefault();
      element.setPointerCapture(e.pointerId);
      const rect = element.getBoundingClientRect();
      origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      move(e);
    });
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    element.style.touchAction = 'none';
  });

  // Gamepads are polled; the API has no change events for buttons or axes.
  const pad = source('gamepad');
  let polling = false;
  const axis = value => (Math.abs(value) < PAD_DEADZONE ? 0 : value);
  function poll() {
    const gamepads = [...navigator.getGamepads()].filter(Boolean);
    pad.buttons = new Set();
    pad.sticks = [[0, 0], [0, 0]];
    for (const gamepad of gamepads) {
      gamepad.buttons.forEach((state, index) => {
        if (state.pressed && PAD_BUTTONS[index] !== undefined) pad.buttons.add(PAD_BUTTONS[index]);
      });
      const [lx = 0, ly = 0, rx = 0, ry = 0] = gamepad.axes;
      pad.sticks[0][0] += axis(lx); pad.sticks[0][1] -= axis(ly);
      pad.sticks[1][0] += axis(rx); pad.sticks[1][1] -= axis(ry);
    }
    flush();
    polling = gamepads.length > 0;
    if (polling) requestAnimationFrame(poll);
  }
  window.addEventListener('gamepadconnected', () => { if (!polling) poll(); });
  window.addEventListener('gamepaddisconnected', () => { if (!polling) poll(); });
}
