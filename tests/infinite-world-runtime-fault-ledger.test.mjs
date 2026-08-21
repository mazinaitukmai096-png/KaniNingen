import test from 'node:test';
import assert from 'node:assert/strict';

import { createRuntimeFaultLedger } from '../src/infinite-world/runtime-fault-ledger.js';

test('runtime fault ledger bounds records and retains structured context', () => {
  let now = 10;
  const ledger = createRuntimeFaultLedger({ capacity: 2, clock: () => now++ });
  for (let index = 0; index < 3; index += 1) {
    ledger.record({
      subsystem: 'streaming',
      stage: `stage-${index}`,
      error: new Error(`failure-${index}`),
      action: 'retain-last-known-good',
      frameSequence: index,
      generation: 7,
      ownerKey: '1,2',
    });
  }
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.count, 2);
  assert.equal(snapshot.totalCount, 3);
  assert.deepEqual(snapshot.records.map(record => record.sequence), [2, 3]);
  assert.equal(snapshot.records[1].error.message, 'failure-2');
  assert.equal(snapshot.records[1].action, 'retain-last-known-good');
  assert.equal(snapshot.records[1].ownerKey, '1,2');
});

test('optional observer failure is surfaced once and quarantines only that subsystem', () => {
  const ledger = createRuntimeFaultLedger({ clock: () => 42 });
  let calls = 0;
  const invoke = () => ledger.runObserver({
    subsystem: 'optional-hud',
    stage: 'render',
    frameSequence: 9,
  }, () => {
    calls += 1;
    throw new TypeError('HUD failed');
  }, 'fallback');

  assert.equal(invoke(), 'fallback');
  assert.equal(invoke(), 'fallback');
  assert.equal(calls, 1);
  assert.equal(ledger.isQuarantined('optional-hud'), true);
  assert.equal(ledger.isQuarantined('streaming'), false);
  assert.equal(ledger.snapshot().records[0].error.name, 'TypeError');
});
