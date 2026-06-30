import { z } from 'zod';

export const SessionTerminalComposerSubmitRequestV1Schema = z
  .object({
    sessionId: z.string().trim().min(1),
    expectedStateAtMs: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type SessionTerminalComposerSubmitRequestV1 = z.infer<typeof SessionTerminalComposerSubmitRequestV1Schema>;

export const SessionTerminalComposerSubmitSuccessStatusV1Schema = z.enum([
  'submitted',
  'already_empty',
]);
export type SessionTerminalComposerSubmitSuccessStatusV1 =
  z.infer<typeof SessionTerminalComposerSubmitSuccessStatusV1Schema>;

export const SessionTerminalComposerSubmitFailureStatusV1Schema = z.enum([
  'unsupported',
  'no_live_terminal',
  'not_safe',
  'generating',
  'dialog_open',
  'capture_unavailable',
  'submit_failed',
  'host_dead',
]);
export type SessionTerminalComposerSubmitFailureStatusV1 =
  z.infer<typeof SessionTerminalComposerSubmitFailureStatusV1Schema>;

export const SessionTerminalComposerSubmitResultV1Schema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      status: SessionTerminalComposerSubmitSuccessStatusV1Schema,
      sessionId: z.string().min(1).optional(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      status: SessionTerminalComposerSubmitFailureStatusV1Schema,
      sessionId: z.string().min(1).optional(),
      errorCode: z.string().min(1).optional(),
      error: z.string().min(1).optional(),
    })
    .passthrough(),
]);
export type SessionTerminalComposerSubmitResultV1 =
  z.infer<typeof SessionTerminalComposerSubmitResultV1Schema>;

export function buildUnsupportedSessionTerminalComposerSubmitResult(
  sessionId: string,
  method: string,
): SessionTerminalComposerSubmitResultV1 {
  return SessionTerminalComposerSubmitResultV1Schema.parse({
    ok: false,
    status: 'unsupported',
    sessionId,
    errorCode: 'unsupported_session_runtime_method',
    error: `unsupported_session_runtime_method:${method}`,
  });
}
