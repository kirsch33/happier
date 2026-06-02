import type { ActiveGoalSnapshot } from '@/agent/runtime/sessionGoals/activeGoalSnapshot';

export function buildSessionAutonomyContinuationPrompt(goal: ActiveGoalSnapshot): string {
  return [
    'Happier autonomy continuation:',
    `Continue the active goal: ${goal.objective}`,
    'Use the latest transcript and work state. If the goal is done, paused, or blocked, update the canonical Happier goal/work-state controls accordingly. Do not create private provider scheduled tasks.',
  ].join('\n\n');
}
