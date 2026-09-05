type SessionMachineDaemonIdentityRecord = Readonly<{
    daemonState?: unknown;
    /** Accepted only to make explicit that this mutable counter is ignored. */
    daemonStateVersion?: unknown;
}> | null | undefined;

/**
 * Returns the opaque lifetime of the daemon that can answer continuation RPCs.
 *
 * `daemonStateVersion` is deliberately absent: it is a mutation counter, not an
 * instance identity, and can advance while the same daemon remains authoritative.
 * Current daemons preserve the same `startedAt` across relay reconnects; its pair
 * with PID is also the daemon-state file's existing cleanup ownership identity.
 * PID alone keeps the cache bounded during transition from older daemons whose
 * reconnect path rewrote `startedAt`.
 */
export function resolveSessionContinuationDaemonGeneration(
    machine: SessionMachineDaemonIdentityRecord,
): string | null {
    const daemonState = machine?.daemonState;
    if (!daemonState || typeof daemonState !== 'object') return null;

    const pid = Reflect.get(daemonState, 'pid');
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null;

    const startedAt = Reflect.get(daemonState, 'startedAt');
    if (typeof startedAt === 'number' && Number.isSafeInteger(startedAt) && startedAt >= 0) {
        return `process:${pid}:${startedAt}`;
    }
    return `pid:${pid}`;
}
