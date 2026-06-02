import {
  readDisplayableSessionWorkStateV1,
  type SessionInitialGoalRequestV1,
  type SessionWorkStateItemV1,
} from '@happier-dev/protocol';

export type ActiveGoalSnapshot = Readonly<{
  itemId: string;
  objective: string;
  tokenBudget?: number | null;
}>;

function isActiveGoalItem(item: SessionWorkStateItemV1): boolean {
  return item.kind === 'goal' && item.status === 'active';
}

function chooseActiveGoalItem(
  items: readonly SessionWorkStateItemV1[],
  primaryItemId: string | null | undefined,
): SessionWorkStateItemV1 | null {
  const primaryActive = primaryItemId
    ? items.find((item) => item.id === primaryItemId && isActiveGoalItem(item))
    : null;
  return primaryActive ?? items.find(isActiveGoalItem) ?? null;
}

export function readActiveInitialGoalFromSessionWorkStateMetadata(
  metadata: Record<string, unknown> | null | undefined,
): SessionInitialGoalRequestV1 | null {
  const activeGoal = readActiveGoalSnapshotFromSessionWorkStateMetadata(metadata);
  if (!activeGoal) return null;

  return {
    objective: activeGoal.objective,
    status: 'active',
    ...(Object.prototype.hasOwnProperty.call(activeGoal, 'tokenBudget')
      ? { tokenBudget: activeGoal.tokenBudget ?? null }
      : {}),
  };
}

export function readActiveGoalSnapshotFromSessionWorkStateMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ActiveGoalSnapshot | null {
  const workState = readDisplayableSessionWorkStateV1(metadata?.sessionWorkStateV1);
  if (!workState) return null;

  const activeGoal = chooseActiveGoalItem(workState.items, workState.primaryItemId);
  if (!activeGoal) return null;

  return {
    itemId: activeGoal.id,
    objective: activeGoal.title,
    ...(Object.prototype.hasOwnProperty.call(activeGoal, 'tokenBudget')
      ? { tokenBudget: activeGoal.tokenBudget ?? null }
      : {}),
  };
}
