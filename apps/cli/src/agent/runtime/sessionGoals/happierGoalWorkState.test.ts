import { describe, expect, it } from 'vitest';

import { mergeHappierInitialGoalIntoSessionWorkStateMetadata } from './happierGoalWorkState';

describe('mergeHappierInitialGoalIntoSessionWorkStateMetadata', () => {
  it('merges a Happier-owned active goal without removing Claude-owned work-state items', () => {
    const next = mergeHappierInitialGoalIntoSessionWorkStateMetadata(
      {
        sessionWorkStateV1: {
          v: 1,
          backendId: 'claude',
          agentId: 'claude',
          updatedAt: 100,
          primaryItemId: 'todo:derived:claude.todo:Run%20tests%7C0',
          items: [
            {
              id: 'todo:derived:claude.todo:Run%20tests%7C0',
              kind: 'todo',
              origin: 'vendor',
              status: 'active',
              title: 'Run tests',
              backendId: 'claude',
              agentId: 'claude',
              updatedAt: 100,
            },
          ],
        },
      },
      {
        sessionId: 'happy-session-1',
        backendId: 'claude',
        agentId: 'claude',
        nowMs: 200,
        initialGoal: {
          objective: 'Keep Overwatch driving',
          status: 'active',
          tokenBudget: 1200,
        },
      },
    );

    expect(next.sessionWorkStateV1).toMatchObject({
      backendId: 'claude',
      agentId: 'claude',
      updatedAt: 200,
      primaryItemId: 'goal:derived:happier.goal:happy-session-1',
    });
    expect(next.sessionWorkStateV1.items).toEqual([
      expect.objectContaining({
        id: 'todo:derived:claude.todo:Run%20tests%7C0',
        kind: 'todo',
        title: 'Run tests',
      }),
      expect.objectContaining({
        id: 'goal:derived:happier.goal:happy-session-1',
        kind: 'goal',
        origin: 'happier',
        status: 'active',
        title: 'Keep Overwatch driving',
        tokenBudget: 1200,
      }),
    ]);
  });
});
