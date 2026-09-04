---
name: decompose-gates
description: Decompose a hard or multi-part task into independently checkable pieces with explicit verification gates and risk-weighted ordering. Use when a task is too large to verify as a whole.
---

# Decompose With Gates

Turn a hard task into pieces that can each pass or fail on their own, ordered so the riskiest assumption is tested first.

## Procedure

1. **Split along verification boundaries, not implementation convenience.** Each piece must have its own pass/fail check that does not depend on the other pieces being right. If checking B assumes A is correct, A+B is one piece, not two.
2. **State each piece as a falsifiable claim, not a task.** "The watermark advances only after server ack" (checkable) — not "update watermark logic" (a task). Attach to each claim the concrete check that decides it: a test slice, a log observation, a live replay, a measurement.
3. **Name the risk spots before sequencing.** Write the two or three "if I'm wrong anywhere, it's here" spots — silent failure modes, irreversible steps, boring mechanical stretches — and design a specific verification for each. Generic suite runs are uniform effort against non-uniform risk.
4. **Order by information yield.** Run first the piece whose failure invalidates the rest (e.g. "the event fires before layout"). A ten-minute check beats three days built on a false premise.
5. **Write down inter-piece assumptions.** What each piece assumes from the others is itself a piece to check; most integration failures live at those interfaces, not inside the pieces.
6. **Right-size.** A piece owns a whole responsibility end to end: analysis, change, tests, validation. Too small to fail meaningfully is overhead — micro-slicing (one-boolean extractions) provably grew the god-files it was meant to shrink. Too big to check independently is not decomposed yet.
7. **Prefer consumed verticals over horizontal spines.** The first implementation slice should connect a real entry point through its canonical owner to an observable outcome. Do not split protocol/schema/producer/consumer into weeks of dormant layers whose correctness can only be known after activation. When compatibility forces phases, each phase names its active reader/consumer and removal condition.
8. **Firewall live-path corrections.** If gated or dormant work exposes a live dispatch, lifecycle, persistence, migration, or startup defect, handle that correction as its own complete vertical at the live owner. Do not partially activate the dormant design to fix the production path.

For compatibility-sensitive work, name the released baseline, old/new producer-consumer direction, and any reachable prepare, activation, migration, rollback, and removal claims. Do not invent phases for an additive or internal-only change.

## Output

A short plan listing: the pieces as claims, each with its deciding check; the named risk spots with their specific verifications; the ordering and why; the inter-piece assumptions.

## Failure this prevents

The monolithic change where something works but you cannot say which part, and something fails but you cannot say where.
