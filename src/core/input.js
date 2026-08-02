const NOOP = () => {};

export function createInputController({
  documentTarget = document,
  windowTarget = window,
  onKeyDown = NOOP,
  onKeyUp = NOOP,
  onMouseMove = NOOP,
  onWheel = NOOP,
  onMouseDown = NOOP,
  onMouseUp = NOOP,
  onPointerLockChange = NOOP,
  onBlur = NOOP,
} = {}) {
  const keys = Object.create(null);
  let disposed = false;

  function clearPressedKeys() {
    for (const code of Object.keys(keys)) delete keys[code];
  }

  const inputSnapshot = Object.freeze({
    isPressed(code) {
      return keys[code] === true;
    },
  });

  const handlers = {
    keydown(event) {
      keys[event.code] = true;
      onKeyDown(event);
    },
    keyup(event) {
      keys[event.code] = false;
      onKeyUp(event);
    },
    mousemove(event) {
      onMouseMove(event);
    },
    wheel(event) {
      onWheel(event);
    },
    mousedown(event) {
      onMouseDown(event);
    },
    mouseup(event) {
      onMouseUp(event);
    },
    pointerlockchange(event) {
      onPointerLockChange(event);
    },
    blur(event) {
      clearPressedKeys();
      onBlur(event);
    },
    contextmenu(event) {
      event.preventDefault();
    },
  };

  documentTarget.addEventListener('keydown', handlers.keydown);
  documentTarget.addEventListener('keyup', handlers.keyup);
  documentTarget.addEventListener('mousemove', handlers.mousemove);
  documentTarget.addEventListener('wheel', handlers.wheel, { passive: true });
  documentTarget.addEventListener('mousedown', handlers.mousedown);
  documentTarget.addEventListener('mouseup', handlers.mouseup);
  documentTarget.addEventListener('pointerlockchange', handlers.pointerlockchange);
  windowTarget.addEventListener('contextmenu', handlers.contextmenu);
  windowTarget.addEventListener('blur', handlers.blur);

  return Object.freeze({
    getInputSnapshot() {
      return inputSnapshot;
    },
    clearPressedKeys,
    dispose() {
      if (disposed) return;
      disposed = true;

      documentTarget.removeEventListener('keydown', handlers.keydown);
      documentTarget.removeEventListener('keyup', handlers.keyup);
      documentTarget.removeEventListener('mousemove', handlers.mousemove);
      documentTarget.removeEventListener('wheel', handlers.wheel);
      documentTarget.removeEventListener('mousedown', handlers.mousedown);
      documentTarget.removeEventListener('mouseup', handlers.mouseup);
      documentTarget.removeEventListener('pointerlockchange', handlers.pointerlockchange);
      windowTarget.removeEventListener('contextmenu', handlers.contextmenu);
      windowTarget.removeEventListener('blur', handlers.blur);

      clearPressedKeys();
    },
  });
}
