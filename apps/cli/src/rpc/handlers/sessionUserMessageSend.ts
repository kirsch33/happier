import {
  readSessionUserMessageDeliveryIntentMeta,
  sanitizeSessionUserMessageSendMeta,
  SessionUserMessageSendRequestSchema,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { resolveTrustedSessionAttachmentLocalImagePaths } from '@/session/attachments/resolveTrustedSessionAttachmentLocalImagePaths';
import type { SessionRuntimeControls } from './sessionControls';

export function registerSessionUserMessageSendHandler(
  rpc: RpcHandlerRegistrar,
  opts: Readonly<{
    workingDirectory: string;
    enqueueSessionUserMessage?: ((request: {
      text: string;
      localId?: string;
      meta: Record<string, unknown>;
    }) => Promise<void> | void) | null;
    commitSessionUserMessage?: ((request: {
      text: string;
      localId?: string;
      meta: Record<string, unknown>;
    }) => Promise<void> | void) | null;
    sessionRuntimeControls?: SessionRuntimeControls | null;
  }>,
): void {
  if (
    typeof opts.enqueueSessionUserMessage !== 'function'
    && typeof opts.commitSessionUserMessage !== 'function'
  ) return;

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, async (raw: unknown) => {
    const rawMeta = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { meta?: unknown }).meta
      : undefined;
    const parsed = SessionUserMessageSendRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: 'Invalid params', errorCode: 'session_user_message_invalid_input' };
    }

    const rawMetaRecord = rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta)
      ? rawMeta as Record<string, unknown>
      : parsed.data.meta;
    const allowedLocalImagePaths = await resolveTrustedSessionAttachmentLocalImagePaths({
      cwd: opts.workingDirectory,
      metadata: rawMetaRecord,
    });
    const meta = sanitizeSessionUserMessageSendMeta(rawMetaRecord, {
      allowedLocalImagePaths,
    });
    const request = {
      text: parsed.data.text,
      localId: parsed.data.localId,
      meta,
    };

    if (readSessionUserMessageDeliveryIntentMeta(meta) === 'transcript_only') {
      if (typeof opts.commitSessionUserMessage !== 'function') {
        return {
          ok: false,
          error: 'session.userMessage.send transcript-only commit is unavailable',
          errorCode: 'session_user_message_commit_unavailable',
        };
      }
      await opts.commitSessionUserMessage(request);
      return { ok: true };
    }

    const runtimeResult = typeof opts.sessionRuntimeControls?.handleUserMessage === 'function'
      ? await opts.sessionRuntimeControls.handleUserMessage(request)
      : null;
    if (runtimeResult?.handled === true) {
      return runtimeResult.result;
    }

    if (typeof opts.enqueueSessionUserMessage !== 'function') {
      return {
        ok: false,
        error: 'session.userMessage.send enqueue is unavailable',
        errorCode: 'session_user_message_enqueue_unavailable',
      };
    }
    await opts.enqueueSessionUserMessage?.(request);
    if (
      request.localId
      && typeof opts.sessionRuntimeControls?.waitForUserMessageQueueCustody === 'function'
    ) {
      const custodyResult = await opts.sessionRuntimeControls.waitForUserMessageQueueCustody({
        localId: request.localId,
        timeoutMs: 5_000,
      });
      if (
        custodyResult
        && typeof custodyResult === 'object'
        && !Array.isArray(custodyResult)
        && (custodyResult as { ok?: unknown }).ok === false
      ) {
        return custodyResult;
      }
    }
    return { ok: true };
  });
}
