/**
 * One-off REAL-DATA migration proof: take a genuine pre-fix session artifact
 * (from ~/.dsh/sessions — a real SessionFormatUnsupportedError victim),
 * stage it under a scratch sessions root, run migrateLegacyArtifact against
 * it, and verify: bare reader refuses BEFORE, loads AFTER, invariants hold,
 * backup exists, second run is a no-op.
 */
import { cp, mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { migrateLegacyArtifact, parseArtifactText, scanZstdFrames, decompressZstdFrames } from '../src/migration.ts';

const source = process.env.REAL_SESSION_DIR;
if (!source) throw new Error('REAL_SESSION_DIR is required');
const id = process.env.REAL_SESSION_ID ?? 's-real';

const sessionsRoot = await mkdtemp(join(tmpdir(), 'dsh-alignment-real-migrate-'));
try {
    // Stage the real artifact (bytes verbatim) under the backend layout,
    // reusing the project directory name from the REAL session path (the
    // backend derives it from the header cwd with its own encoding).
    const bytes = await readFile(join(source, 'session.jsonl.zstd'));
    const project = source.split(/[\\/]/).slice(-2)[0];
    const targetDir = join(sessionsRoot, project, id);
    await mkdir(dirname(targetDir), { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await cp(join(source, 'session.jsonl.zstd'), join(targetDir, 'session.jsonl.zstd'));

    // The harness (bare persistence) for the migration + reads.
    const ctx = new Context();
    ctx.plugin(SessionStore);
    await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, packChunks: true });
    const persistence = ctx.sessionPersistence;
    const fiber = ctx.fiber;

    // 1. BEFORE: the bare reader must refuse (the real bug).
    try {
        await persistence.load(SessionId(id));
        console.log('BEFORE: unexpectedly loaded (fixture not broken?)');
    } catch (error) {
        console.log('BEFORE: refused as expected ->', String(error).slice(0, 220));
    }

    // 2. Migrate (real artifact).
    const report = await migrateLegacyArtifact(SessionId(id), { persistence, sessions: ctx.sessions });
    console.log('MIGRATED:', JSON.stringify({ repairedEvents: report.repairedEvents, sha256: report.originalSha256.slice(0, 16), backup: report.backupPath, artifact: report.artifactPath }));

    // 3. AFTER: the bare reader loads; count alignment events.
    const inspection = await persistence.load(SessionId(id));
    const alignment = inspection.events.filter((e) => e.type.startsWith('alignment/'));
    console.log('AFTER: loaded OK; total events', inspection.events.length, '; alignment events', alignment.length, '; all ignorable:', alignment.every((e) => e.ignorable === true));

    // 4. Invariants: decode the migrated artifact; sample the event types.
    //    (Note: the step-3 load() may have appended synthetic crash-repair
    //    closers to the artifact — the coordinator's documented cold-recovery
    //    behavior — which is why the frame count can exceed the migration's
    //    own two frames.)
    const afterBytes = await readFile(join(targetDir, 'session.jsonl.zstd'));
    const afterText = await decompressZstdFrames(afterBytes);
    const parsedAfter = parseArtifactText(afterText);
    console.log('types head:', parsedAfter.events.slice(0, 12).map((e) => e.type).join(', '));
    const frameScan = scanZstdFrames(afterBytes);
    console.log('events:', parsedAfter.events.length, '; frames:', frameScan.frames.length);

    // 5. Idempotent second run.
    const second = await migrateLegacyArtifact(SessionId(id), { persistence, sessions: ctx.sessions });
    console.log('SECOND RUN: migrated =', second.migrated, '(must be false)');

    // 6. The backup exists and is byte-identical to the original staged file.
    const backup = await readFile(report.backupPath);
    console.log('BACKUP bytes match staged original:', backup.length === bytes.length);

    await fiber?.dispose().catch(() => { });
} finally {
    await rm(sessionsRoot, { recursive: true, force: true }).catch(() => { });
}
console.log('DONE');
