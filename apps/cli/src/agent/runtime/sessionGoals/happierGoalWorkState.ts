import {
  buildDeterministicSessionWorkStateItemId,
  type SessionInitialGoalRequestV1,
  type SessionWorkStateItemV1,
  type SessionWorkStateV1,
} from '@happier-dev/protocol';

import { mergeSessionWorkStateMetadataV1 } from '@/session/workState/sessionWorkStateMetadata';

const HAPPIER_GOAL_SOURCE_FAMILY = 'happier.goal';
const HAPPIER_GOAL_OWNED_SOURCE_FAMILY = 'goal:derived:happier.goal';

type MetadataRecord = Record<string, unknown>;

export function mergeHappierInitialGoalIntoSessionWorkStateMetadata<TMetadata extends object>(
  metadata: TMetadata,
  params: Readonly<{
    sessionId: string;
    backendId: string;
    agentId?: string;
    nowMs: number;
    initialGoal: SessionInitialGoalRequestV1;
  }>,
): TMetadata & Readonly<{ sessionWorkStateV1: ReturnType<typeof mergeSessionWorkStateMetadataV1>['sessionWorkStateV1'] }> {
  const objective = params.initialGoal.objective?.trim();
  if (!objective) {
    throw new Error('Happier initial goal objective is required.');
  }

  const goalItem: SessionWorkStateItemV1 = {
    id: buildDeterministicSessionWorkStateItemId({
      kind: 'goal',
      sourceFamily: HAPPIER_GOAL_SOURCE_FAMILY,
      stableParts: [params.sessionId],
    }),
    kind: 'goal',
    origin: 'happier',
    status: params.initialGoal.status ?? 'active',
    title: objective,
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    vendorRef: params.sessionId,
    ...(Object.prototype.hasOwnProperty.call(params.initialGoal, 'tokenBudget')
      ? { tokenBudget: params.initialGoal.tokenBudget ?? null }
      : {}),
    createdAt: params.nowMs,
    updatedAt: params.nowMs,
  };

  const nextOwned: SessionWorkStateV1 = {
    v: 1,
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    updatedAt: params.nowMs,
    items: [goalItem],
    primaryItemId: goalItem.id,
  };

  const next = mergeSessionWorkStateMetadataV1({
    metadata,
    nextOwned,
    ownedSourceFamilies: [HAPPIER_GOAL_OWNED_SOURCE_FAMILY],
  });

  return {
    ...(metadata as MetadataRecord),
    sessionWorkStateV1: next.sessionWorkStateV1,
  } as TMetadata & Readonly<{ sessionWorkStateV1: typeof next.sessionWorkStateV1 }>;
}
