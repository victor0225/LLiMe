import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createCorrectionPlayback } from '../web/voice.js';

// The voice client is a stub that records its playback calls in order; the client's own pause, mute
// and play behaviour is covered by the voice client tests.
function stubClient() {
  const calls: string[] = [];
  return { calls, client: { interruptPlayback: () => calls.push('interruptPlayback'), resumePlayback: () => calls.push('resumePlayback') } };
}

describe('playback during a correction', () => {
  test('a correction during speech interrupts playback at once and only its replacement reopens the speaker (stub voice client)', () => {
    const { calls, client } = stubClient();
    const playback = createCorrectionPlayback(client);

    playback.correctionStarted(2);
    assert.deepEqual(calls, ['interruptPlayback'], 'playback stops before any request is answered');
    assert.equal(playback.isInterrupted, true);

    assert.equal(playback.replacementRendered(1), false, 'the superseded activity being acknowledged does not reopen the speaker');
    assert.deepEqual(calls, ['interruptPlayback']);

    assert.equal(playback.replacementRendered(2), true);
    assert.deepEqual(calls, ['interruptPlayback', 'resumePlayback'], 'the speaker reopens for the validated replacement, so its commentary is heard');
    assert.equal(playback.isInterrupted, false);
  });

  test('a second correction before the replacement keeps playback off until the newest replacement (stub voice client)', () => {
    const { calls, client } = stubClient();
    const playback = createCorrectionPlayback(client);
    playback.correctionStarted(2);
    playback.correctionStarted(3);
    assert.equal(playback.replacementRendered(2), false);
    assert.equal(playback.isInterrupted, true);
    assert.equal(playback.replacementRendered(3), true);
    assert.deepEqual(calls, ['interruptPlayback', 'interruptPlayback', 'resumePlayback']);
  });

  test('a render with no correction pending never touches playback (stub voice client)', () => {
    const { calls, client } = stubClient();
    assert.equal(createCorrectionPlayback(client).replacementRendered(4), false);
    assert.deepEqual(calls, []);
  });
});
