// Credential-free, opt-in packed CLI check. ROOT must be a prepare-host-probe
// directory with the CLI and packed plugin already installed into cli-home.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(process.argv[2] ?? '');
assert.match(basename(root), /^alignment-0\.1\.7-rc\.2-/);
assert.equal(JSON.parse(await readFile(join(root, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version, '0.1.7-rc.2');
const env = { ...process.env, DSH_HOME: join(root, 'cli-home'), DO_NOT_TRACK: '1' };
// Do not forward provider credentials to the disposable host.
for (const key of Object.keys(env)) if (/(API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)) delete env[key];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function boot() {
    const child = spawn(process.execPath, [join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const exited = new Promise(resolve => child.once('exit', resolve));
    const stop = async () => {
        if (child.exitCode === null) child.kill();
        await exited;
    };
    try {
        for (let i = 0; i < 300; i++) {
            const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
            const match = clean.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/);
            if (match) {
                const url = new URL(match[0]);
                const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
                assert.equal(login.status, 303);
                const cookie = login.headers.get('set-cookie')?.split(';')[0];
                assert.ok(cookie);
                return { child, stop, origin: url.origin, cookie };
            }
            if (child.exitCode !== null) throw new Error(`CLI exited ${child.exitCode}`);
            await delay(200);
        }
        throw new Error('CLI startup timeout');
    } catch (error) {
        await stop();
        // Never echo host output: it can contain a generated login token.
        throw new Error(`${error.message}; captured host output withheld (${output.length} chars)`);
    }
}
async function request(host, path, method = 'GET', body) {
    const headers = { origin: host.origin, 'x-dsh-requirements-alignment': '1' };
    headers.cookie = host.cookie;
    if (body) headers['content-type'] = 'application/json';
    const response = await fetch(host.origin + path, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { status: response.status, text: await response.text() };
}
const base = '/_dsh/requirements-alignment';
let host;
try {
    host = await boot();
    assert.equal((await request(host, '/')).status, 200);
    assert.equal((await request(host, `${base}/status`)).status, 400);
    let result = await request(host, `${base}/shared-mode`, 'PUT', { mode: 'manual' });
    assert.equal(result.status, 200, result.text);
    assert.equal(JSON.parse(result.text).snapshot.effectiveMode, 'manual');
    await host.stop();
    const profile = await readFile(join(root, 'cli-home/profiles/web/cordis.patch.yml'), 'utf8');
    assert.match(profile, /runtimeMode: manual/);
    host = await boot();
    // Reset goes through the shipped SettingsForms + ConfigEditor, not a fake.
    result = await request(host, `${base}/shared-mode`, 'DELETE');
    assert.equal(result.status, 200, result.text);
    assert.equal(JSON.parse(result.text).snapshot.effectiveMode, 'auto');
    assert.equal(JSON.parse(result.text).snapshot.effectiveSource, 'profile');
    const resetProfile = await readFile(join(root, 'cli-home/profiles/web/cordis.patch.yml'), 'utf8');
    assert.match(resetProfile, /runtimeMode: null/);
    console.log(JSON.stringify({ status: 'passed', host: '0.1.7-rc.2', checks: ['packed CLI boot', 'root HTTP 200', 'status validation 400', 'native shared mode write', 'profile disk persistence', 'restart and native reset'], ui: 'not tested', model: 'not tested' }));
} finally {
    if (host) {
        const origin = host.origin;
        await host.stop();
        await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(2000) }));
        console.log('Owned CLI stopped; listener closed.');
    }
}
