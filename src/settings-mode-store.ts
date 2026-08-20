/**
 * The DSH Settings-backed ModeStore port.
 *
 * Persistence model (official `@deepseek-ai/dsh-settings` semantics):
 *
 *   resolved = schema( defaults + composition base + user document section )
 *
 * - `base` carries the profile default (`config.mode`) — the composition
 *   layer, exactly what the entry config owns. The user document section
 *   (`settings.yaml`, hot-reloaded by the file provider) is the persisted
 *   override layer. `replace({})` is the reset path: it removes the user
 *   section and re-inherits the base.
 * - The storage schema is deliberately permissive (`Schema.any()`): an
 *   invalid stored override must NOT fail plugin startup (a strict schema
 *   path would reject the registration itself). ModeStore owns strict
 *   validation and repairs the document when it detects an invalid override.
 * - Change observation rides the scope `watch` (resolved-value changes) plus
 *   the provider's `settings/document-updated` event (raw-section changes,
 *   which fire even when an override equals the base).
 *
 * Ownership: `settings.register()` is an effect on the *calling* fiber
 * (Cordis service context tracing), and the watchers/event listener are
 * `ctx.effect` entries on the plugin fiber, so the namespace registration
 * and its observers all die with the plugin — no orphan registrations
 * survive an unload.
 *
 * Attach strategy: `ctx.get('settings')` reads the service synchronously
 * when it is already running (the shipped web profile starts the settings
 * row before plugin rows), so the startup snapshot includes a persisted
 * override immediately. When the service is absent or starts later, the
 * `ctx.inject` fallback attaches the moment it becomes available, and a
 * provider reload re-attaches because the dependent fiber re-runs.
 *
 * @module dsh-requirements-alignment/settings-mode-store
 */
import type { Context } from '@deepseek-ai/cordis';
import { settingsNamespace, type SettingsProvider, type SettingsScope } from '@deepseek-ai/dsh-settings';
import Schema from '@deepseek-ai/schemastery';
import { ModeStore, type ModeStorePort, type ModeStoreRead } from './mode-store.ts';
import type { AlignmentMode } from './types.ts';

/** Lowercase kebab-case namespace owned by this plugin (pattern-checked at brand time). */
export const SETTINGS_NAMESPACE = settingsNamespace('requirements-alignment');

/**
 * Permissive storage schema. The settings layer must never reject a stored
 * section — a strict enum schema would fail the registration itself on an
 * invalid stored override and take the plugin down (v0.3.0 rule: an invalid
 * override must never fail startup). ModeStore validates on read and repairs.
 */
export const MODE_SETTINGS_SCHEMA = Schema.any();

/** Whether a value is a plain record (the only shape a mode section can be). */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ModeStorePort over the DSH Settings service. Read-only on the raw document,
 * writes go through the registered scope; `persistable` flips true once the
 * settings service is attached.
 */
export class SettingsModeStorePort implements ModeStorePort {
    private readonly ctx: Context;
    private readonly defaultMode: AlignmentMode;
    private provider: SettingsProvider | undefined;
    private scope: SettingsScope<unknown> | undefined;
    private changeCallback: (() => void) | undefined;
    private disposed = false;

    constructor(ctx: Context, defaultMode: AlignmentMode) {
        this.ctx = ctx;
        this.defaultMode = defaultMode;
    }

    /** Whether the settings service is attached and writes can persist. */
    get persistable(): boolean {
        return this.scope !== undefined;
    }

    /** Attach to the settings service, synchronously or via inject. */
    attach(): void {
        if (this.disposed) return;
        const provider = this.ctx.get('settings');
        if (provider !== undefined) {
            this.attachProvider(provider);
            return;
        }
        this.ctx.inject(['settings'], (sctx) => {
            if (this.disposed) return;
            this.attachProvider(sctx.settings);
        });
    }

    read(): ModeStoreRead {
        const scope = this.scope;
        if (scope === undefined) {
            return { resolvedMode: this.defaultMode, userHasMode: false };
        }
        const resolved = scope.get();
        return {
            resolvedMode: isRecord(resolved) ? resolved.mode : undefined,
            userHasMode: this.userSectionHasMode()
        };
    }

    async writeOverride(mode: AlignmentMode): Promise<void> {
        const scope = this.requireScope();
        await scope.update({ mode });
    }

    async clearOverride(): Promise<void> {
        if (this.scope === undefined) return;
        await this.scope.replace({});
    }

    watch(callback: () => void): () => void {
        this.changeCallback = callback;
        return () => {
            if (this.changeCallback === callback) this.changeCallback = undefined;
        };
    }

    dispose(): void {
        this.disposed = true;
        this.provider = undefined;
        this.scope = undefined;
        this.changeCallback = undefined;
    }

    private attachProvider(provider: SettingsProvider): void {
        if (this.disposed) return;
        if (this.provider === provider) return; // already attached to this instance (sync + inject both fired)
        if (this.scope !== undefined) {
            // A previous provider instance was replaced (reload); drop the stale
            // handle so the re-registration below is clean.
            this.scope = undefined;
        }
        let scope: SettingsScope<unknown>;
        try {
            scope = provider.register(SETTINGS_NAMESPACE, MODE_SETTINGS_SCHEMA, {
                base: { mode: this.defaultMode }
            });
        } catch (error) {
            // Case 7 guard: an unreadable/invalid stored section must not take
            // the plugin down. Degrade to entry-only; the next successful read
            // (after the document is repaired externally) re-attaches.
            this.ctx.logger?.warn(
                'requirements-alignment: settings registration rejected (invalid stored section?); '
                + 'staying on the profile default mode: %o',
                error
            );
            return;
        }
        this.provider = provider;
        this.scope = scope;
        // Observers are plugin-fiber effects: disposed on unload, idempotent
        // with the provider's own teardown.
        this.ctx.effect(() => {
            const offWatch = scope.watch(() => this.onChange());
            const offEvent = this.ctx.on('settings/document-updated', (ns: unknown) => {
                if (ns === SETTINGS_NAMESPACE) this.onChange();
            });
            return () => {
                offWatch();
                offEvent();
            };
        });
        this.onChange();
    }

    private requireScope(): SettingsScope<unknown> {
        const scope = this.scope;
        if (scope === undefined) {
            throw new Error('requirements-alignment: cannot persist a mode override: no settings service is mounted');
        }
        return scope;
    }

    private userSectionHasMode(): boolean {
        const provider = this.provider;
        if (provider === undefined) return false;
        for (const descriptor of provider.describe()) {
            if (descriptor.ns !== SETTINGS_NAMESPACE) continue;
            const user = descriptor.user;
            return isRecord(user) && 'mode' in user;
        }
        return false;
    }

    private onChange(): void {
        if (this.disposed) return;
        this.changeCallback?.();
    }
}

/**
 * Create the runtime ModeStore over the DSH Settings service with the
 * profile default as the base layer. Falls back to entry-only when no
 * settings service is (or will be) mounted.
 */
export function createModeStore(
    ctx: Context,
    entry: { mode: AlignmentMode },
    logger?: { warn(message?: string, ...optionalParams: unknown[]): void }
): ModeStore {
    const port = new SettingsModeStorePort(ctx, entry.mode);
    port.attach();
    return new ModeStore(port, entry.mode, logger);
}

export default SettingsModeStorePort;
