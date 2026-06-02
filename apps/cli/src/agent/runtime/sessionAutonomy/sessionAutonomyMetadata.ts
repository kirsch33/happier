export const SESSION_AUTONOMY_METADATA_KEY = 'sessionAutonomyV1';

export type SessionAutonomyMetadataV1 = Readonly<{
  v: 1;
  goalItemId: string;
  status: 'active' | 'inactive';
  cadenceMs: number;
  nextWakeAt: string | null;
  lastWakeAt?: string | null;
  wakeAttempt: number;
  lastWakeLocalId?: string | null;
  inFlightLocalId?: string | null;
  updatedAt: string;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readFiniteNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readString(value) ?? undefined;
}

export function readSessionAutonomyMetadataV1(
  metadata: Record<string, unknown> | null | undefined,
): SessionAutonomyMetadataV1 | null {
  const record = asRecord(metadata?.[SESSION_AUTONOMY_METADATA_KEY]);
  if (!record || record.v !== 1) return null;

  const goalItemId = readString(record.goalItemId);
  const status = record.status === 'active' || record.status === 'inactive' ? record.status : null;
  const cadenceMs = readFiniteNonNegativeInteger(record.cadenceMs);
  const nextWakeAt = readNullableString(record.nextWakeAt);
  const wakeAttempt = readFiniteNonNegativeInteger(record.wakeAttempt);
  const updatedAt = readString(record.updatedAt);
  if (!goalItemId || !status || cadenceMs === null || nextWakeAt === undefined || wakeAttempt === null || !updatedAt) {
    return null;
  }

  const lastWakeAt = readNullableString(record.lastWakeAt);
  const lastWakeLocalId = readNullableString(record.lastWakeLocalId);
  const inFlightLocalId = readNullableString(record.inFlightLocalId);

  return {
    v: 1,
    goalItemId,
    status,
    cadenceMs,
    nextWakeAt,
    wakeAttempt,
    updatedAt,
    ...(lastWakeAt !== undefined ? { lastWakeAt } : {}),
    ...(lastWakeLocalId !== undefined ? { lastWakeLocalId } : {}),
    ...(inFlightLocalId !== undefined ? { inFlightLocalId } : {}),
  };
}

export function withSessionAutonomyMetadataV1(
  metadata: Record<string, unknown>,
  sessionAutonomyV1: SessionAutonomyMetadataV1,
): Record<string, unknown> {
  return {
    ...metadata,
    [SESSION_AUTONOMY_METADATA_KEY]: sessionAutonomyV1,
  };
}
