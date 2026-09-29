import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as Record<string, Record<string, string> | undefined>;

test('shared DSH host contracts are peers instead of ordinary dependencies', () => {
    const sharedHostPackages = [
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-system-prompt',
        '@deepseek-ai/dsh-tools',
        '@deepseek-ai/dsh-session',
        '@deepseek-ai/dsh-storage-domain',
        '@deepseek-ai/dsh-user-questions',
        '@deepseek-ai/dsh-settings'
    ];

    for (const packageName of sharedHostPackages) {
        assert.equal(manifest.dependencies?.[packageName], undefined);
        assert.equal(typeof manifest.peerDependencies?.[packageName], 'string');
        assert.equal(typeof manifest.devDependencies?.[packageName], 'string');
        assert.ok(manifest.peerDependencies?.[packageName]?.includes('0.1.7-rc.2')
            || packageName === '@deepseek-ai/cordis');
    }
});
