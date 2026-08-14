import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_POLICY,
    MANUAL_CHECK_MESSAGE,
    POLICY_ORDER,
    POLICY_SECTION,
    autoPolicyText,
    noRepeatLine
} from '../src/policy.ts';

test('policy: section metadata is stable (order after plan-mode, unique name)', () => {
    assert.equal(POLICY_ORDER, 60);
    assert.equal(POLICY_SECTION, 'requirements-alignment:policy');
});

test('policy: auto text on a fresh session renders the full policy', () => {
    const text = autoPolicyText(undefined, { questionRounds: 0 });
    // Case 1: greenfield trigger guidance present.
    assert.match(text, /Greenfield Alignment Gate/);
    assert.match(text, /product goal/);
    assert.match(text, /MVP scope/);
    assert.match(text, /primary interaction/);
    // Native mechanism, one question at a time.
    assert.match(text, /ask_user_question/);
    assert.match(text, /ONE question at a time/);
    // Case 2/3: no interview for explicit work.
    assert.match(text, /Do not interrupt the user for filenames/);
    assert.match(text, /EXPLICIT/);
    // Case 4: no silent defaults even when the user says pick whatever.
    assert.match(text, /Do not let a reversible, low-risk, or common technical default/);
    assert.match(text, /pick whatever makes sense.*does not waive alignment/s);
    assert.match(text, /still ask the ONE highest-priority direction-defining question/);
    // Case 5: re-alignment rule.
    assert.match(text, /Re-align only when a NEW direction-defining decision/);
    // Stop rule.
    assert.match(text, /Do not turn alignment into an interview/);
});

test('policy: auto text appends the no-repeat guard after the first question round', () => {
    const fresh = autoPolicyText(undefined, { questionRounds: 0 });
    const aligned = autoPolicyText(undefined, { questionRounds: 1 });
    assert.ok(aligned.includes(fresh));
    assert.match(aligned, /already completed 1 alignment question round/);
    assert.match(aligned, /Do not re-run alignment for settled decisions/);
    const twice = autoPolicyText(undefined, { questionRounds: 2 });
    assert.match(twice, /already completed 2 alignment question round/);
});

test('policy: custom section replaces the default and keeps the no-repeat guard', () => {
    const custom = autoPolicyText('Custom direction policy.', { questionRounds: 0 });
    assert.equal(custom, 'Custom direction policy.');
    const aligned = autoPolicyText('Custom direction policy.', { questionRounds: 1 });
    assert.match(aligned, /^Custom direction policy./);
    assert.match(aligned, /already completed 1 alignment question round/);
});

test('policy: manual check message is complete enough to drive a check alone', () => {
    // Case 6: /align steers this message.
    assert.match(MANUAL_CHECK_MESSAGE, /Requirements Alignment check \(manual\)/);
    assert.match(MANUAL_CHECK_MESSAGE, /ask_user_question/);
    assert.match(MANUAL_CHECK_MESSAGE, /ONE question at a time/);
    assert.match(MANUAL_CHECK_MESSAGE, /Do not ask about filenames/);
    assert.match(MANUAL_CHECK_MESSAGE, /greenfield\/vague/);
});

test('policy: no-repeat line names the exact condition for re-alignment', () => {
    const line = noRepeatLine(3);
    assert.match(line, /3 alignment question round/);
    assert.match(line, /only re-align when the user requests something that introduces a NEW direction-defining decision/);
});

test('policy: shipped default policy is a single coherent section', () => {
    assert.ok(DEFAULT_POLICY.length > 500);
    assert.ok(DEFAULT_POLICY.startsWith('## Requirements Alignment policy'));
});