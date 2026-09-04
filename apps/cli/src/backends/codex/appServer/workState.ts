import {
    normalizeCodexAppServerGoalToSessionWorkStateItem,
    type SessionWorkStateItemV1,
    type SessionWorkStateStatusReasonV1,
    type SessionWorkStateV1,
    type SessionWorkStateWriteSnapshotV1,
} from '@happier-dev/protocol';

import { mergeSessionWorkStateMetadataV1 } from '@/session/workState/sessionWorkStateMetadata';

type MetadataRecord = Record<string, unknown>;

const CODEX_BACKEND_ID = 'codex';
const LEGACY_CODEX_GOAL_ITEM_ID = 'goal:codex:thread';
const LEGACY_CODEX_GOAL_ITEM_PREFIX = 'goal:codex:';

function asRecord(value: unknown): MetadataRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as MetadataRecord : null;
}

function readItems(value: unknown): MetadataRecord[] {
    return Array.isArray(value) ? value.map(asRecord).filter((entry): entry is MetadataRecord => Boolean(entry)) : [];
}

function readString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readNonNegativeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readCurrentWorkState(metadata: unknown, backendId: string): MetadataRecord {
    const current = asRecord(asRecord(metadata)?.sessionWorkStateV1) ?? {};
    return {
        ...current,
        v: 1,
        backendId: readString(current.backendId) ?? backendId,
        updatedAt: readNonNegativeInteger(current.updatedAt) ?? 0,
        items: readItems(current.items),
    };
}

function isCodexGoalItem(item: MetadataRecord): boolean {
    const id = readString(item.id);
    if (id === LEGACY_CODEX_GOAL_ITEM_ID) return true;
    if (id?.startsWith(LEGACY_CODEX_GOAL_ITEM_PREFIX)) return true;
    return item.kind === 'goal'
        && item.origin === 'vendor'
        && item.backendId === CODEX_BACKEND_ID;
}

export function mergeCodexGoalIntoSessionWorkStateMetadata<TMetadata extends object>(
    metadata: TMetadata,
    goal: unknown,
    options: Readonly<{
        backendId?: string;
        agentId?: string;
        statusReason?: SessionWorkStateStatusReasonV1;
    }> = {},
): TMetadata & { sessionWorkStateV1: SessionWorkStateWriteSnapshotV1 } {
    const backendId = options.backendId ?? CODEX_BACKEND_ID;
    const normalizedItem = normalizeCodexAppServerGoalToSessionWorkStateItem({
        backendId,
        ...(options.agentId ? { agentId: options.agentId } : {}),
        goal,
    });

    if (!normalizedItem) {
        return removeCodexGoalFromSessionWorkStateMetadata(metadata, { backendId });
    }
    const item = options.statusReason
        ? { ...normalizedItem, statusReason: options.statusReason }
        : normalizedItem;

    const current = readCurrentWorkState(metadata, backendId);
    const existingCodexGoalItemIds = readItems(current.items)
        .filter(isCodexGoalItem)
        .map((existingItem) => readString(existingItem.id))
        .filter((id): id is string => Boolean(id));
    const nextOwned: SessionWorkStateV1 = {
        v: 1,
        backendId,
        ...(options.agentId ? { agentId: options.agentId } : {}),
        updatedAt: item.updatedAt,
        items: [item],
        primaryItemId: item.id,
    };
    // The merge chokepoint resolves `primaryItemId` canonically over the MERGED
    // item set (shared `resolveSessionWorkStatePrimaryItemId`), so this path no
    // longer re-derives its own primary — one rule, no Codex-local duplicate.
    return {
        ...metadata,
        ...mergeSessionWorkStateMetadataV1({
            metadata,
            nextOwned,
            ownedItemIds: [...existingCodexGoalItemIds, item.id, LEGACY_CODEX_GOAL_ITEM_ID],
            ownedItemIdPrefixes: [LEGACY_CODEX_GOAL_ITEM_PREFIX],
        }),
    };
}

export function removeCodexGoalFromSessionWorkStateMetadata<TMetadata extends object>(
    metadata: TMetadata,
    options: Readonly<{
        backendId?: string;
    }> = {},
): TMetadata & { sessionWorkStateV1: SessionWorkStateWriteSnapshotV1 } {
    const backendId = options.backendId ?? CODEX_BACKEND_ID;
    const current = readCurrentWorkState(metadata, backendId);
    const ownedItemIds = readItems(current.items)
        .filter(isCodexGoalItem)
        .map((item) => readString(item.id))
        .filter((id): id is string => Boolean(id));

    const nextOwned: SessionWorkStateV1 = {
        v: 1,
        backendId,
        updatedAt: readNonNegativeInteger(current.updatedAt) ?? 0,
        items: [] satisfies SessionWorkStateItemV1[],
        primaryItemId: null,
    };
    // Primary is re-resolved canonically at the merge chokepoint after the Codex
    // goal item is removed; no Codex-local primary computation here.
    return {
        ...metadata,
        ...mergeSessionWorkStateMetadataV1({
            metadata,
            nextOwned,
            ownedItemIds,
            ownedItemIdPrefixes: [LEGACY_CODEX_GOAL_ITEM_PREFIX],
        }),
    };
}
