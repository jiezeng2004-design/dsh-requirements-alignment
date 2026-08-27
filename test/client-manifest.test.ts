/**
 * DSH 0.1.1 client graph regression.
 *
 * Package-level `dsh.client.inject` names client graph modules: each dependency
 * must publish its own `dsh.client` row and client bundle. The rc.1 and rc.2
 * manifests for runtime and locale do; ui-slots publishes only the pure slot
 * registry library (no `dsh.client`, no `./client` export), so it cannot be a
 * graph edge.
 *
 * Browser-level `const inject = ['slots', 'locale']` is a separate Cordis
 * service contract. The capsule consumes both services and must keep them in
 * the source and the built artifact even though ui-slots is absent from the
 * package graph.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);

const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as {
    name: string;
    dsh: { client: { platform: string; inject: string[] } };
};
const sourceClient = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8');
const builtClient = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function browserInjectNames(code: string): string[] {
    const needle = 'const inject = [';
    const start = code.indexOf(needle);
    assert.ok(start >= 0, 'browser client must declare a const inject array');
    const open = start + needle.length;
    const close = code.indexOf(']', open);
    assert.ok(close > open, 'browser inject array must be closed');
    return code.slice(open, close)
        .split(',')
        .map((value) => value.trim().replace(/['"]/g, ''))
        .filter(Boolean);
}

test('client manifest: package graph contains only real rc.2 client modules', () => {
    assert.equal(manifest.dsh.client.platform, 'web');
    assert.deepEqual(manifest.dsh.client.inject, [
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-locale'
    ]);
    assert.equal(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'), false);

    for (const dependency of manifest.dsh.client.inject) {
        const dependencyManifest = JSON.parse(
            readFileSync(require.resolve(dependency + '/package.json'), 'utf8')
        ) as {
            dsh?: { client?: unknown };
            exports?: Record<string, unknown>;
        };
        assert.notEqual(dependencyManifest.dsh?.client, undefined, dependency + ' must publish dsh.client');
        assert.notEqual(dependencyManifest.exports?.['./client'], undefined, dependency + ' must export ./client');
    }
});

test('client manifest: browser service injection keeps slots and locale in source and build', () => {
    for (const [label, code] of [
        ['src/client/index.js', sourceClient],
        ['lib/client.js', builtClient]
    ] as const) {
        assert.deepEqual(browserInjectNames(code), ['slots', 'locale'], label);
    }
});

test('client manifest: built contract registers one shell.overlay occupant', async () => {
    assert.ok(builtClient.includes(`window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}`));
    assert.ok(builtClient.includes("ctx.slots.inject('shell.overlay'"));
    assert.ok(builtClient.includes("name: 'shell.overlay'"));
    assert.ok(builtClient.includes("id: 'requirements-alignment'"));
    assert.equal((builtClient.match(/ctx\.slots\.inject\('shell\.overlay'/g) ?? []).length, 1);
});
