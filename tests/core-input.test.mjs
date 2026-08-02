import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputController } from '../src/core/input.js';

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener));
  }

  dispatch(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ preventDefault() {}, ...event });
    }
  }
}

test('input controller clears every pressed key on window blur', () => {
  const documentTarget = new FakeEventTarget();
  const windowTarget = new FakeEventTarget();
  let blurCount = 0;
  const controller = createInputController({
    documentTarget,
    windowTarget,
    onBlur: () => { blurCount += 1; },
  });
  const snapshot = controller.getInputSnapshot();

  for (const code of ['KeyW', 'ShiftLeft', 'Space']) {
    documentTarget.dispatch('keydown', { code });
    assert.equal(snapshot.isPressed(code), true);
  }

  windowTarget.dispatch('blur');

  assert.equal(blurCount, 1);
  for (const code of ['KeyW', 'ShiftLeft', 'Space']) {
    assert.equal(snapshot.isPressed(code), false);
  }
  controller.dispose();
});

test('manual clear and dispose remove pressed state and listeners', () => {
  const documentTarget = new FakeEventTarget();
  const windowTarget = new FakeEventTarget();
  const controller = createInputController({ documentTarget, windowTarget });
  const snapshot = controller.getInputSnapshot();

  documentTarget.dispatch('keydown', { code: 'KeyA' });
  controller.clearPressedKeys();
  assert.equal(snapshot.isPressed('KeyA'), false);

  documentTarget.dispatch('keydown', { code: 'KeyD' });
  controller.dispose();
  assert.equal(snapshot.isPressed('KeyD'), false);
  documentTarget.dispatch('keydown', { code: 'KeyW' });
  assert.equal(snapshot.isPressed('KeyW'), false);
});
