import type { SessionEvent } from '@deepseek-ai/dsh-session/types';

/** DSH 0.1.2+ reads history on demand; older hosts expose an events array. */
export interface SessionEventSource {
    readonly events?: readonly SessionEvent[];
    snapshotEvents?(): readonly SessionEvent[];
}

export function sessionEvents(session: SessionEventSource): readonly SessionEvent[] {
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents();
    if (Array.isArray(session.events)) return session.events;
    throw new Error('requirements-alignment: host provides no supported session history API');
}
