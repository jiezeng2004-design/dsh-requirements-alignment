import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_POLICY,
    MANUAL_CHECK_MESSAGE,
    POLICY_ORDER,
    POLICY_SECTION,
    autoPolicyText,
    baselineSummary
} from '../src/policy.ts';
import type { AlignmentStatus, RequirementBaseline } from '../src/types.ts';

const baseline: RequirementBaseline = {
    revision: 2,
    goal: 'Optimize the existing result page',
    explicitConstraints: ['Preserve existing business logic', 'Keep public API compatible'],
    updatedAt: 1000
};

function status(overrides: Partial<AlignmentStatus> = {}): AlignmentStatus {
    return {
        revision: 0,
        driftCount: 0,
        status: 'unknown',
        manualChecks: 0,
        ...overrides
    };
}

test('policy: section metadata is stable (order after plan-mode, unique name)', () => {
    assert.equal(POLICY_ORDER, 60);
    assert.equal(POLICY_SECTION, 'requirements-alignment:policy');
});

test('policy: auto text on a fresh session renders the full drift-guard policy', () => {
    const text = autoPolicyText(undefined, status());
    // Positioning: runtime drift guard, not a plan pre-layer.
    assert.match(text, /requirement baseline/);
    assert.match(text, /Plan Mode reviews plans/);
    assert.match(text, /guards intent continuity during execution/);
    // Silent monitoring: no periodic checks, no tool-call counting.
    assert.match(text, /zero interruption/);
    assert.match(text, /Never check alignment periodically/);
    // Baseline establishment rules (auto mode, no forced questions).
    assert.match(text, /establish_baseline/);
    assert.match(text, /If the request is trivial and unambiguous/);
    // Drift taxonomy and protocol.
    assert.match(text, /Scope expansion/);
    assert.match(text, /Architecture or product-shape shift/);
    assert.match(text, /report_drift/);
    // Mid-task direction changes go through the drift protocol, not plain questions.
    assert.match(text, /A user direction change is the clearest drift candidate/);
    assert.match(text, /report_drift \(reason: user-direction-change\)/);
    assert.match(text, /ask_user_question is only for the initial greenfield direction question/);
    // Agent autonomy (never-ask list).
    assert.match(text, /filenames, helper placement, variable naming/);
    // Child agent rule.
    assert.match(text, /Child agents/);
    assert.match(text, /Requirement drift candidate/);
    // No greenfield question gate waived by delegation.
    assert.match(text, /pick whatever makes sense/);
    // No hard gate claims.
    assert.doesNotMatch(text, /block execution/);
});

test('policy: a fresh session without a baseline renders no summary', () => {
    const text = autoPolicyText(undefined, status());
    assert.doesNotMatch(text, /Current requirement baseline/);
});

test('policy: baseline summary renders recorded fields only', () => {
    const summary = baselineSummary(status({
        baseline,
        revision: 2,
        status: 'aligned'
    }));
    assert.match(summary, /Current requirement baseline \(revision 2\):/);
    assert.match(summary, /Goal: Optimize the existing result page/);
    assert.match(summary, /- Preserve existing business logic/);
    assert.doesNotMatch(summary, /Must preserve/);
    assert.doesNotMatch(summary, /Open direction decisions/);
});

test('policy: open drift is called out in the summary', () => {
    const summary = baselineSummary(status({
        driftCount: 1,
        status: 'drift-pending',
        lastDrift: { reason: 'architecture-shift', description: 'cloud sync', at: 1 }
    }));
    assert.match(summary, /Current requirement baseline: implicit/);
    assert.match(summary, /Last drift: architecture-shift - cloud sync/);
    assert.match(summary, /Open drift:/);
});

test('policy: auto text appends the summary once a baseline is recorded', () => {
    const fresh = autoPolicyText(undefined, status());
    const withBaseline = autoPolicyText(undefined, status({ baseline, revision: 2, status: 'aligned' }));
    assert.ok(withBaseline.includes(fresh));
    assert.match(withBaseline, /Current requirement baseline \(revision 2\):/);
});

test('policy: custom section replaces the default and keeps the summary', () => {
    const custom = autoPolicyText('Custom drift policy.', status({ baseline, revision: 2, status: 'aligned' }));
    assert.ok(custom.startsWith('Custom drift policy.'));
    assert.match(custom, /Current requirement baseline \(revision 2\):/);
    const freshCustom = autoPolicyText('Custom drift policy.', status());
    assert.equal(freshCustom, 'Custom drift policy.');
});

test('policy: manual check message inspects alignment and never claims a gate', () => {
    assert.match(MANUAL_CHECK_MESSAGE, /Requirements Alignment check \(manual\)/);
    assert.match(MANUAL_CHECK_MESSAGE, /Fold the current requirement baseline/);
    assert.match(MANUAL_CHECK_MESSAGE, /report_drift/);
    assert.match(MANUAL_CHECK_MESSAGE, /never blocks execution/);
    assert.match(MANUAL_CHECK_MESSAGE, /never replaces plan mode/);
});

test('policy: shipped default policy is a single coherent section', () => {
    assert.ok(DEFAULT_POLICY.length > 500);
    assert.ok(DEFAULT_POLICY.startsWith('## Requirements Alignment policy'));
});

test('policy: explicit protected constraints demand establish_baseline BEFORE the first mutation', () => {
    // The trigger-phrase list must be part of the shipped policy.
    for (const phrase of [
        'do not change X',
        'without changing X',
        'preserve X',
        'keep X compatible',
        'only change X',
        'do not refactor Y',
        'no backend changes',
        'keep public API unchanged',
        'no UI changes'
    ]) {
        assert.ok(DEFAULT_POLICY.includes(phrase), `policy must list the trigger phrase "${phrase}"`);
    }
    // Timing: before the first substantive implementation or mutation, silent,
    // no user interaction, no full specification.
    assert.match(DEFAULT_POLICY, /BEFORE the first substantive implementation or mutation/);
    assert.match(DEFAULT_POLICY, /silent - it never asks the user/);
    assert.match(DEFAULT_POLICY, /Do not start editing until the baseline is recorded/);
    assert.match(DEFAULT_POLICY, /no user interaction, no full specification - just the durable boundary/);
    // Trivial tasks remain exempt.
    assert.match(DEFAULT_POLICY, /If the request is trivial and unambiguous/);
});

test('policy: drift must be reported BEFORE implementation, never as a post-hoc summary', () => {
    assert.match(DEFAULT_POLICY, /call report_drift BEFORE taking the direction-changing action/);
    assert.match(DEFAULT_POLICY, /before substantive implementation of the changed direction, never after the fact as a summary/);
    assert.match(DEFAULT_POLICY, /ask_user_question is only for the initial greenfield direction question/);
});

test('policy: custom direction options record as a revised direction, not a rejection', () => {
    assert.match(DEFAULT_POLICY, /pass the distinct candidate directions as the report_drift options argument/);
    assert.match(DEFAULT_POLICY, /the user's chosen option is a revised direction \(note = the chosen option label\), never a rejection/);
});

test('policy: baseline-update-pending is called out in the summary', () => {
    const summary = baselineSummary(status({
        baseline,
        revision: 2,
        status: 'baseline-update-pending',
        driftCount: 1,
        lastDrift: { reason: 'architecture-shift', description: 'cloud sync', at: 1 },
        lastDecision: { driftSeq: 1, decision: 'approve', at: 2 }
    }));
    assert.match(summary, /Baseline update pending/);
    assert.match(summary, /Call establish_baseline with the updated baseline BEFORE the next substantive step/);
});

test('policy: the summary projects the user choice and required change (resume recovery)', () => {
    const summary = baselineSummary(status({
        baseline,
        revision: 2,
        status: 'baseline-update-pending',
        driftCount: 1,
        lastDrift: { reason: 'user-direction-change', description: 'cross-device', requiredChange: 'baseline becomes cross-device', at: 1 },
        lastDecision: { driftSeq: 1, decision: 'revise', note: 'Use export files', at: 2 }
    }));
    // The exact selected direction survives in the projected summary, so a
    // resumed session knows what the user picked without re-asking.
    assert.match(summary, /Last user decision: revise - Use export files/);
    assert.match(summary, /required change: baseline becomes cross-device/);
    assert.match(summary, /Baseline update pending: the user chose a new direction: Use export files/);
});

test('policy: a reject with a note-less decision still shows the last decision', () => {
    const summary = baselineSummary(status({
        baseline,
        revision: 2,
        status: 'aligned',
        driftCount: 1,
        lastDrift: { reason: 'constraint-conflict', description: 'backend refactor', at: 1 },
        lastDecision: { driftSeq: 1, decision: 'reject', at: 2 }
    }));
    assert.match(summary, /Last user decision: reject/);
    assert.doesNotMatch(summary, /Last user decision: reject -/);
});

test('policy: manual check message still never claims a gate', () => {
    assert.match(MANUAL_CHECK_MESSAGE, /never blocks execution/);
    assert.match(MANUAL_CHECK_MESSAGE, /never replaces plan mode/);
});
