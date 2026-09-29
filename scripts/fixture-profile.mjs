// Test-only profile editor. SettingsForms is real; this substitutes only its
// profile/loader I/O boundary. Real CLI acceptance must be reported separately.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit';
import SettingsForms from '@deepseek-ai/dsh-settings';
import Controller, { ConfigSchema } from '../src/index.ts';

export async function mountFixtureProfile(ctx, root) {
    const path = join(root, 'profile-fixture.json');
    let raw;
    try { raw = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; raw = {}; }
    const inherited = { mode: 'auto', section: 'Protected fixture policy' };
    const entry = { id: 'renamed-alignment', options: { id: 'renamed-alignment', config: { ...inherited, ...raw } } };
    const editor = {
        writable: true,
        documentPath: path,
        entries: () => [entry],
        configuration: () => [{ entry, inherited, override: raw }],
        async edit(target, transform) {
            if (target !== entry) throw new Error('unexpected fixture entry');
            const next = transform(entry.options.config, inherited);
            const parsed = ConfigSchema({ ...inherited, ...next });
            raw = isDeepStrictEqual(next, inherited) ? {} : next;
            await writeFile(path, JSON.stringify(raw));
            entry.options.config = { ...inherited, ...raw };
            updateVolatile(entry.fiber.config.mode, createVolatile(parsed.mode.get()));
            updateVolatile(entry.fiber.config.runtimeMode, createVolatile(parsed.runtimeMode.get()));
        }
    };
    ctx.provide('configEditor', editor);
    ctx.provide('profileContext', { home: root, name: 'isolated-fixture' });
    ctx.provide('loader', { await: async () => {} });
    await ctx.plugin(SettingsForms);
    entry.fiber = ctx.plugin(Controller, entry.options.config);
    await entry.fiber;
    if (ctx.settings.describe().length === 0) throw new Error(`Fixture descriptor missing: state=${entry.fiber.state}, schema=${Boolean(entry.fiber.runtime?.Config)}`);
    return { entry, editor, inherited, read: () => raw };
}
