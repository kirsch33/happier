import { normalizeClaudeUnifiedPromptIdentityText } from './promptIdentity';

const DEFAULT_LIMIT = 32;
const DEFAULT_PREFIX_RESIDUE_WINDOW_MS = 2 * 60_000;
const MIN_PREFIX_RESIDUE_CHARS = 256;
const MIN_CURRENT_BATCH_FRAGMENT_CHARS = 60;
const MIN_CURRENT_BATCH_FRAGMENT_TOKENS = 8;

export type ClaudeOwnComposerTextLog = Readonly<{
  /** Record a text WE wrote into the TUI (injected prompt). Bounded FIFO. */
  record: (text: string) => void;
  /**
   * True when the composer draft matches recorded own text, or a recent long prefix residue from
   * an interrupted own injection. Short/old prefixes are intentionally rejected so a genuine user
   * draft does not classify as ours.
   */
  matches: (draft: string, opts?: Readonly<{ currentBatchText?: string | null | undefined }>) => boolean;
}>;

function normalize(value: string): string {
  return normalizeClaudeUnifiedPromptIdentityText(value);
}

/**
 * Soft-wrap-insensitive form (C11 live, runner pid 20327): the TUI renders a long draft wrapped
 * across lines, so equality must ignore WHERE whitespace breaks fall — but every word must still
 * match exactly (a genuine user draft never collapses to a recorded text).
 */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ');
}

type OwnComposerTextLogEntry = Readonly<{
  text: string;
  candidates: readonly string[];
  recordedAtMs: number;
}>;

function isRecentPrefixResidue(params: Readonly<{
  entry: OwnComposerTextLogEntry;
  normalizedDraft: string;
  collapsedDraft: string;
  nowMs: number;
  prefixResidueWindowMs: number;
}>): boolean {
  if (
    params.normalizedDraft.length < MIN_PREFIX_RESIDUE_CHARS
    || params.entry.text.length <= params.normalizedDraft.length
    || params.nowMs - params.entry.recordedAtMs > params.prefixResidueWindowMs
  ) {
    return false;
  }
  // tmux/zellij captures sometimes expose only the visible wrapped middle/tail of Claude's
  // composer after our Enter did not submit. Treat a long recent fragment as own residue, but
  // keep the high length and short time window so normal user drafts remain foreign.
  return params.entry.text.includes(params.normalizedDraft)
    || params.entry.candidates.some((candidate) => (
      candidate.length > params.collapsedDraft.length
      && candidate.includes(params.collapsedDraft)
  ));
}

function countFragmentTokens(value: string): number {
  return value.match(/[A-Za-z0-9_/-]+/g)?.length ?? 0;
}

function isCurrentBatchFragment(params: Readonly<{
  currentBatchText?: string | null | undefined;
  normalizedDraft: string;
  collapsedDraft: string;
}>): boolean {
  const currentBatchText = typeof params.currentBatchText === 'string'
    ? normalize(params.currentBatchText)
    : '';
  if (
    currentBatchText.length === 0
    || params.normalizedDraft.length < MIN_CURRENT_BATCH_FRAGMENT_CHARS
    || countFragmentTokens(params.normalizedDraft) < MIN_CURRENT_BATCH_FRAGMENT_TOKENS
    || currentBatchText.length <= params.normalizedDraft.length
  ) {
    return false;
  }
  const collapsedCurrentBatchText = collapseWhitespace(currentBatchText);
  return currentBatchText.includes(params.normalizedDraft)
    || (
      collapsedCurrentBatchText.length > params.collapsedDraft.length
      && collapsedCurrentBatchText.includes(params.collapsedDraft)
    );
}

/**
 * Bounded log of texts the Claude Unified runtime itself wrote into the TUI (lane X, incident
 * cmq8y3nlx): a leftover composer draft that matches one of them, including a bounded recent long
 * prefix from a truncated injection, is OUR OWN residue and may be cleared, while anything else is
 * treated as a genuine user draft.
 */
export function createClaudeOwnComposerTextLog(opts?: Readonly<{
  limit?: number;
  nowMs?: (() => number) | undefined;
  prefixResidueWindowMs?: number | undefined;
}>): ClaudeOwnComposerTextLog {
  const limit = Math.max(1, Math.trunc(opts?.limit ?? DEFAULT_LIMIT));
  const nowMs = opts?.nowMs ?? Date.now;
  const prefixResidueWindowMs = Math.max(0, Math.trunc(opts?.prefixResidueWindowMs ?? DEFAULT_PREFIX_RESIDUE_WINDOW_MS));
  const entries: OwnComposerTextLogEntry[] = [];

  return {
    record(text) {
      const normalized = normalize(text);
      if (normalized.length === 0) return;
      const lines = normalized
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      entries.push({
        text: normalized,
        candidates: [normalized, collapseWhitespace(normalized), ...lines],
        recordedAtMs: nowMs(),
      });
      while (entries.length > limit) entries.shift();
    },
    matches(draft, matchOpts) {
      const normalized = normalize(draft);
      if (normalized.length === 0) return false;
      const collapsed = collapseWhitespace(normalized);
      const referenceMs = nowMs();
      return entries.some((entry) => (
        entry.candidates.includes(normalized)
        || entry.candidates.includes(collapsed)
        || isRecentPrefixResidue({
          entry,
          normalizedDraft: normalized,
          collapsedDraft: collapsed,
          nowMs: referenceMs,
          prefixResidueWindowMs,
        })
      )) || isCurrentBatchFragment({
        currentBatchText: matchOpts?.currentBatchText ?? null,
        normalizedDraft: normalized,
        collapsedDraft: collapsed,
      });
    },
  };
}
