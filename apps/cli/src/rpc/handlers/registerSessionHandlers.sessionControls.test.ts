import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionUsageLimitRecoveryOperationResultV1Schema } from '@happier-dev/protocol';
import type { Metadata } from '@/api/types';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

const featureDecisionMocks = vi.hoisted(() => ({
  resolveCliFeatureDecisionForServer: vi.fn(async () => ({
    decision: { state: 'enabled' },
  })),
}));

vi.mock('@/features/featureDecisionService', () => ({
  resolveCliFeatureDecisionForServer: featureDecisionMocks.resolveCliFeatureDecisionForServer,
}));

import { registerSessionHandlers } from './registerSessionHandlers';

function createRegistrar(): { handlers: Map<string, RpcHandler>; registrar: RpcHandlerRegistrar } {
  const handlers = new Map<string, RpcHandler>();
  return {
    handlers,
    registrar: {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    },
  };
}

function parseUsageLimitResult(value: unknown) {
  return SessionUsageLimitRecoveryOperationResultV1Schema.parse(value);
}

describe('registerSessionHandlers session controls', () => {
  beforeEach(() => {
    featureDecisionMocks.resolveCliFeatureDecisionForServer.mockReset();
    featureDecisionMocks.resolveCliFeatureDecisionForServer.mockResolvedValue({
      decision: { state: 'enabled' },
    });
  });

  it('fails usage-limit recovery RPCs closed when the feature is disabled for the target server', async () => {
    featureDecisionMocks.resolveCliFeatureDecisionForServer.mockResolvedValue({
      decision: { state: 'disabled' },
    });
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true }));
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true }));
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true }));
    const updateSessionMetadata = vi.fn();

    registerSessionHandlers(registrar, process.cwd(), {
      updateSessionMetadata,
      sessionRuntimeControls: {
        enableUsageLimitWaitResume,
        cancelUsageLimitWaitResume,
        checkUsageLimitRecoveryNow,
      },
    });

    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      rememberPreference: true,
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    });
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    });
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'sess_1',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    });

    expect(enableUsageLimitWaitResume).not.toHaveBeenCalled();
    expect(cancelUsageLimitWaitResume).not.toHaveBeenCalled();
    expect(checkUsageLimitRecoveryNow).not.toHaveBeenCalled();
    expect(updateSessionMetadata).not.toHaveBeenCalled();
  });

  it('routes goal RPCs to runtime goal controls and returns current work state', async () => {
    const { handlers, registrar } = createRegistrar();
    const refreshGoal = vi.fn(async () => {});
    const setGoal = vi.fn(async () => {});
    const clearGoal = vi.fn(async () => {});
    const workState = {
      v: 1,
      backendId: 'codex',
      updatedAt: 1,
      items: [
        {
          id: 'goal:thread-1',
          kind: 'goal',
          origin: 'vendor',
          status: 'active',
          title: 'Ship goal controls',
          updatedAt: 1,
        },
      ],
      primaryItemId: 'goal:thread-1',
    };
    const metadata: Metadata & { sessionWorkStateV1: typeof workState } = {
      path: process.cwd(),
      host: 'test-host',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happier',
      happyLibDir: '/tmp/.happier/lib',
      happyToolsDir: '/tmp/.happier/tools',
      sessionWorkStateV1: workState,
    };

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => metadata,
      sessionRuntimeControls: {
        refreshGoal,
        setGoal,
        clearGoal,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_GET)?.({})).resolves.toEqual({ workState });
    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({
        objective: '  Ship native goal  ',
        status: 'paused',
        tokenBudget: 1200,
      }),
    ).resolves.toEqual({ workState });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR)?.({})).resolves.toEqual({ workState });

    expect(refreshGoal).toHaveBeenCalledTimes(1);
    expect(setGoal).toHaveBeenCalledWith('Ship native goal', {
      status: 'paused',
      tokenBudget: 1200,
    });
    expect(clearGoal).toHaveBeenCalledTimes(1);
  });

  it('routes terminal composer clear RPCs to runtime controls with typed fallback statuses', async () => {
    const { handlers, registrar } = createRegistrar();
    const clearTerminalComposer = vi.fn(async () => ({
      ok: true,
      status: 'cleared',
      sessionId: 'sess_1',
    }));
    const method = SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR;

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        clearTerminalComposer,
      },
    });

    await expect(handlers.get(method)?.({
      sessionId: 'sess_1',
      expectedStateAtMs: 1_700_000_000_000,
    })).resolves.toEqual({
      ok: true,
      status: 'cleared',
      sessionId: 'sess_1',
    });
    expect(clearTerminalComposer).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      expectedStateAtMs: 1_700_000_000_000,
    });

    const { handlers: unsupportedHandlers, registrar: unsupportedRegistrar } = createRegistrar();
    registerSessionHandlers(unsupportedRegistrar, process.cwd(), {
      sessionRuntimeControls: {},
    });
    await expect(unsupportedHandlers.get(method)?.({ sessionId: 'sess_1' })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'unsupported_session_runtime_method',
      error: `unsupported_session_runtime_method:${method}`,
    });
  });

  it('routes terminal composer submit RPCs to runtime controls with typed fallback statuses', async () => {
    const { handlers, registrar } = createRegistrar();
    const submitTerminalComposer = vi.fn(async () => ({
      ok: true,
      status: 'submitted',
      sessionId: 'sess_1',
    }));
    const method = SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_SUBMIT;

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        submitTerminalComposer,
      },
    });

    await expect(handlers.get(method)?.({
      sessionId: 'sess_1',
      expectedStateAtMs: 1_700_000_000_001,
    })).resolves.toEqual({
      ok: true,
      status: 'submitted',
      sessionId: 'sess_1',
    });
    expect(submitTerminalComposer).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      expectedStateAtMs: 1_700_000_000_001,
    });

    const { handlers: unsupportedHandlers, registrar: unsupportedRegistrar } = createRegistrar();
    registerSessionHandlers(unsupportedRegistrar, process.cwd(), {
      sessionRuntimeControls: {},
    });
    await expect(unsupportedHandlers.get(method)?.({ sessionId: 'sess_1' })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'unsupported_session_runtime_method',
      error: `unsupported_session_runtime_method:${method}`,
    });
  });

  it('routes catalog RPCs to runtime catalog controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const listVendorPlugins = vi.fn(async () => ({
      supported: true,
      vendorPlugins: [{ vendorPluginRef: 'plugin://gmail@openai-curated', name: 'gmail' }],
    }));
    const listSkills = vi.fn(async () => ({
      supported: true,
      skills: [{ name: 'reviewer', origin: 'codex_native' }],
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        listVendorPlugins,
        listSkills,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST)?.({ cwd: ' /override ' })).resolves.toEqual({
      supported: true,
      vendorPlugins: [{ vendorPluginRef: 'plugin://gmail@openai-curated', name: 'gmail' }],
    });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST)?.({ cwd: ' /override ' })).resolves.toEqual({
      supported: true,
      skills: [{ name: 'reviewer', origin: 'codex_native' }],
    });
    expect(listVendorPlugins).toHaveBeenCalledWith({ cwd: '/override' });
    expect(listSkills).toHaveBeenCalledWith({ cwd: '/override' });
  });

  it('routes inline review RPCs to runtime review controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const startInlineReview = vi.fn(async () => ({ ok: true, reviewTurnId: 'turn-review-native' }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        startInlineReview,
      },
    });

    const request = {
      engineIds: ['codex'],
      instructions: 'Check correctness.',
      runLocation: 'current_session',
      changeType: 'uncommitted',
      base: { kind: 'none' },
    };
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE)?.(request)).resolves.toEqual({
      ok: true,
      reviewTurnId: 'turn-review-native',
    });

    expect(startInlineReview).toHaveBeenCalledWith(request);
  });

  it('routes connected-service auth invalidation RPCs to runtime controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const invalidateConnectedServiceAuthTransports = vi.fn(async () => undefined);

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        invalidateConnectedServiceAuthTransports,
      },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS)?.({}),
    ).resolves.toEqual({ ok: true });

    expect(invalidateConnectedServiceAuthTransports).toHaveBeenCalledTimes(1);
  });

  it('routes usage-limit recovery RPCs to runtime controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'cancelled' } }));
    const checkUsageLimitRecoveryNow = vi.fn(async (request: unknown) => {
      if (
        request
        && typeof request === 'object'
        && (request as { operation?: unknown }).operation === 'switch_account_now'
      ) {
        return { ok: true, result: { status: 'switch_attempted', result: { status: 'observed_generation' } } };
      }
      return { ok: true, status: 'waiting' };
    });

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        enableUsageLimitWaitResume,
        cancelUsageLimitWaitResume,
        checkUsageLimitRecoveryNow,
      },
    });

    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      rememberPreference: true,
      resumePromptMode: 'off',
    }))).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
    });
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
    }))).toEqual({
      ok: true,
      status: 'cancelled',
      sessionId: 'sess_1',
    });
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'sess_1',
      provider: 'openai-codex',
    }))).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
    });
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'sess_1',
      provider: 'openai-codex',
      operation: 'switch_account_now',
      resumePromptMode: 'off',
    }))).toEqual({
      ok: true,
      status: 'switch_observed',
      sessionId: 'sess_1',
    });

    expect(enableUsageLimitWaitResume).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      rememberPreference: true,
      resumePromptMode: 'off',
    });
    expect(cancelUsageLimitWaitResume).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
    });
    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      provider: 'openai-codex',
    });
    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      provider: 'openai-codex',
      operation: 'switch_account_now',
      resumePromptMode: 'off',
    });
  });

  it('rejects blank usage-limit issue fingerprints before dispatching runtime controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'cancelled' } }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        enableUsageLimitWaitResume,
        cancelUsageLimitWaitResume,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: '   ',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: '   ',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(enableUsageLimitWaitResume).not.toHaveBeenCalled();
    expect(cancelUsageLimitWaitResume).not.toHaveBeenCalled();
  });

  // QAE-1: "Stop waiting" must reach the daemon recovery schedulers (runtime-auth
  // recovery store) regardless of whether the provider registers a cancel runtime
  // control. The session-side handler propagates every SUCCESSFUL cancel through
  // the injected daemon notifier; a daemon-side waiting intent left armed after a
  // user cancel resumes the session involuntarily at the provider reset time.
  it('propagates successful wait-resume cancels to the daemon recovery owner (runtime-control path)', async () => {
    const { handlers, registrar } = createRegistrar();
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'cancelled' } }));
    const notifyUsageLimitWaitResumeCancelled = vi.fn(async () => ({ ok: true }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        cancelUsageLimitWaitResume,
      },
      notifyUsageLimitWaitResumeCancelled,
    });

    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
    }))).toMatchObject({ ok: true, status: 'cancelled' });
    expect(notifyUsageLimitWaitResumeCancelled).toHaveBeenCalledWith({ sessionId: 'sess_1' });
  });

  it('propagates successful wait-resume cancels to the daemon recovery owner (no provider runtime control)', async () => {
    const { handlers, registrar } = createRegistrar();
    let metadata: Metadata = {
      path: process.cwd(),
      host: 'test-host',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happier',
      happyLibDir: '/tmp/.happier/lib',
      happyToolsDir: '/tmp/.happier/tools',
      sessionUsageLimitRecoveryV1: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'usage-limit:sess_1:reset',
        armedAtMs: 1,
        resetAtMs: null,
        nextCheckAtMs: null,
        attemptCount: 0,
        maxAttempts: 0,
        lastProbeError: null,
        resumePromptMode: 'standard',
        selectedAuth: { kind: 'native' },
      },
    } as Metadata;
    const updateSessionMetadata = vi.fn(async (handler: (metadata: Metadata) => Metadata) => {
      metadata = handler(metadata);
    });
    const notifyUsageLimitWaitResumeCancelled = vi.fn(async () => ({ ok: true }));

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => metadata,
      updateSessionMetadata,
      notifyUsageLimitWaitResumeCancelled,
    });

    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
    }))).toMatchObject({ ok: true, status: 'cancelled' });
    expect(notifyUsageLimitWaitResumeCancelled).toHaveBeenCalledWith({ sessionId: 'sess_1' });
  });

  it('does not propagate failed wait-resume cancels and survives notifier failures', async () => {
    const { handlers, registrar } = createRegistrar();
    const cancelUsageLimitWaitResume = vi.fn(async () => ({
      ok: false,
      errorCode: 'usage_limit_issue_unavailable',
      error: 'usage_limit_issue_unavailable',
    }));
    const notifyUsageLimitWaitResumeCancelled = vi.fn(async () => {
      throw new Error('daemon unreachable');
    });

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        cancelUsageLimitWaitResume,
      },
      notifyUsageLimitWaitResumeCancelled,
    });

    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
    }))).toMatchObject({ ok: false });
    expect(notifyUsageLimitWaitResumeCancelled).not.toHaveBeenCalled();

    // Successful cancel must not fail when the daemon notifier throws (best-effort).
    cancelUsageLimitWaitResume.mockResolvedValueOnce({ ok: true, recovery: { status: 'cancelled' } } as never);
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
    }))).toMatchObject({ ok: true, status: 'cancelled' });
    expect(notifyUsageLimitWaitResumeCancelled).toHaveBeenCalledWith({ sessionId: 'sess_1' });
  });

  it('rejects non-boolean rememberPreference values before dispatching runtime controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        enableUsageLimitWaitResume,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      rememberPreference: 'yes',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(enableUsageLimitWaitResume).not.toHaveBeenCalled();
  });

  it('returns a typed unsupported result instead of fabricating a waiting intent when no runtime recovery hook is installed (F1)', async () => {
    const { handlers, registrar } = createRegistrar();
    let metadata: Metadata = {
      path: process.cwd(),
      host: 'test-host',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happier',
      happyLibDir: '/tmp/.happier/lib',
      happyToolsDir: '/tmp/.happier/tools',
    };
    const updateSessionMetadata = vi.fn(async (handler: (metadata: Metadata) => Metadata) => {
      metadata = handler(metadata);
    });

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => metadata,
      updateSessionMetadata,
    });

    // F1: never `ok: true, status: 'waiting'` with no finite timing and no runner.
    // Without the runtime control there is nothing that can actually wait/resume,
    // so the honest typed result is `unsupported` — not a fabricated intent with
    // null timing and maxAttempts 0.
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      rememberPreference: true,
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'unsupported_session_runtime_method',
    });
    expect((metadata as Record<string, unknown>).sessionUsageLimitRecoveryV1).toBeUndefined();
    expect(updateSessionMetadata).not.toHaveBeenCalled();

    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'sess_1',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'unsupported_session_runtime_method',
    });

    // Cancelling an EXISTING intent stays a valid local metadata operation: it
    // needs no timing and no runner.
    metadata = {
      ...metadata,
      sessionUsageLimitRecoveryV1: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'usage-limit:sess_1:reset',
        armedAtMs: 1,
        resetAtMs: null,
        nextCheckAtMs: null,
        attemptCount: 0,
        maxAttempts: 0,
        lastProbeError: null,
        resumePromptMode: 'standard',
        selectedAuth: { kind: 'native' },
      },
    } as Metadata;
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
    }))).toEqual({
      ok: true,
      status: 'cancelled',
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
    });
    expect((metadata as Record<string, unknown>).sessionUsageLimitRecoveryV1).toMatchObject({
      status: 'cancelled',
    });
    expect(updateSessionMetadata).toHaveBeenCalledTimes(1);
  });

  it('lets runtime message controls intercept provider-specific messages before enqueueing', async () => {
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async () => ({
      handled: true as const,
      result: { ok: true, reviewTurnId: 'turn-review-native' },
    }));
    const enqueueSessionUserMessage = vi.fn(async () => {});

    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage,
      sessionRuntimeControls: {
        handleUserMessage,
      },
    });

    const request = {
      text: '/codex.review focus on regressions',
      localId: 'local-review-command',
      meta: { source: 'test' },
    };
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.(request)).resolves.toEqual({
      ok: true,
      reviewTurnId: 'turn-review-native',
    });

    expect(handleUserMessage).toHaveBeenCalledWith(request);
    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
  });

  it('preserves trusted uploaded image metadata for runtime message controls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-user-message-'));
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async () => ({ handled: false as const }));
    const enqueueSessionUserMessage = vi.fn(async () => {});

    try {
      const uploadedPath = '.happier/uploads/messages/m1/screen.png';
      const uploadedContent = Buffer.from('fake image bytes');
      const sha256 = createHash('sha256').update(uploadedContent).digest('hex');
      await mkdir(join(root, '.happier', 'uploads', 'messages', 'm1'), { recursive: true });
      await writeFile(join(root, uploadedPath), uploadedContent);

      registerSessionHandlers(registrar, root, {
        enqueueSessionUserMessage,
        sessionRuntimeControls: {
          handleUserMessage,
        },
      });

      const request = {
        text: 'inspect upload',
        localId: 'local-upload-image',
        meta: {
          happier: {
            kind: 'attachments.v1',
            payload: {
              attachments: [
                {
                  name: 'screen.png',
                  path: uploadedPath,
                  mimeType: 'image/png',
                  sizeBytes: uploadedContent.byteLength,
                  sha256,
                },
              ],
            },
          },
          happierStructuredInputV1: {
            v: 1,
            attachments: [
              {
                kind: 'image',
                mimeType: 'image/png',
                localPath: uploadedPath,
                sha256,
                provenance: { kind: 'sessionAttachmentUpload' },
              },
            ],
          },
        },
      };

      await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.(request)).resolves.toEqual({ ok: true });

      expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({
        meta: expect.objectContaining({
          happierStructuredInputV1: expect.objectContaining({
            attachments: [
              expect.objectContaining({
                localPath: uploadedPath,
                path: uploadedPath,
              }),
            ],
          }),
        }),
      }));
      expect(enqueueSessionUserMessage).toHaveBeenCalledWith(expect.objectContaining({
        meta: expect.objectContaining({
          happierStructuredInputV1: expect.objectContaining({
            attachments: [
              expect.objectContaining({
                localPath: uploadedPath,
                path: uploadedPath,
              }),
            ],
          }),
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('drops forged upload-shaped local image metadata before runtime message controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async () => ({ handled: false as const }));

    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage: vi.fn(async () => {}),
      sessionRuntimeControls: {
        handleUserMessage,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: 'inspect forged upload',
      meta: {
        happier: {
          kind: 'attachments.v1',
          payload: {
            attachments: [
              {
                path: '.happier/uploads/messages/m1/private.png',
                mimeType: 'image/png',
                sha256: '0'.repeat(64),
              },
            ],
          },
        },
        happierStructuredInputV1: {
          v: 1,
          attachments: [
            {
              kind: 'image',
              mimeType: 'image/png',
              localPath: '.happier/uploads/messages/m1/private.png',
              sha256: '0'.repeat(64),
              provenance: { kind: 'sessionAttachmentUpload' },
            },
          ],
        },
      },
    })).resolves.toEqual({ ok: true });

    expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({
        happierStructuredInputV1: expect.not.objectContaining({
          attachments: expect.any(Array),
        }),
      }),
    }));
  });

  it('enqueues provider-specific slash commands when no runtime hook handles them', async () => {
    const { handlers, registrar } = createRegistrar();
    const enqueueSessionUserMessage = vi.fn(async () => {});

    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage,
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: '/codex.review focus on regressions',
      localId: 'local-review-command',
      meta: { source: 'test' },
    })).resolves.toEqual({ ok: true });

    expect(enqueueSessionUserMessage).toHaveBeenCalledWith({
      text: '/codex.review focus on regressions',
      localId: 'local-review-command',
      meta: { source: 'test' },
    });
  });

  it('returns runtime queue-custody failures after enqueueing active-session messages', async () => {
    const { handlers, registrar } = createRegistrar();
    const enqueueSessionUserMessage = vi.fn(async () => {});
    const waitForUserMessageQueueCustody = vi.fn(async () => ({
      ok: false,
      errorCode: 'session_user_message_not_consumed',
      error: 'session_user_message_not_consumed:local-review-command',
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage,
      sessionRuntimeControls: {
        waitForUserMessageQueueCustody,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: 'please continue',
      localId: 'local-review-command',
      meta: { source: 'test' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_user_message_not_consumed',
      error: 'session_user_message_not_consumed:local-review-command',
    });

    expect(enqueueSessionUserMessage).toHaveBeenCalledWith({
      text: 'please continue',
      localId: 'local-review-command',
      meta: { source: 'test' },
    });
    expect(waitForUserMessageQueueCustody).toHaveBeenCalledWith({
      localId: 'local-review-command',
      timeoutMs: 5_000,
    });
  });

  it('uses the current goal objective for status-only goal updates', async () => {
    const { handlers, registrar } = createRegistrar();
    const setGoal = vi.fn(async () => {});
    const workState = {
      v: 1,
      backendId: 'codex',
      updatedAt: 1,
      items: [
        {
          id: 'goal:thread-1',
          kind: 'goal',
          origin: 'vendor',
          status: 'active',
          title: 'Ship goal controls',
          updatedAt: 1,
        },
      ],
      primaryItemId: 'goal:thread-1',
    };

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => ({
        path: process.cwd(),
        host: 'test-host',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happier',
        happyLibDir: '/tmp/.happier/lib',
        happyToolsDir: '/tmp/.happier/tools',
        sessionWorkStateV1: workState,
      } as Metadata & { sessionWorkStateV1: typeof workState }),
      sessionRuntimeControls: { setGoal },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({ status: 'paused' }),
    ).resolves.toEqual({ workState });

    expect(setGoal).toHaveBeenCalledWith('Ship goal controls', { status: 'paused' });
  });

  it('delegates status-only goal updates to the runtime when metadata has no current objective', async () => {
    const { handlers, registrar } = createRegistrar();
    const runtimeResult = {
      ok: false,
      errorCode: 'goal_not_found',
      error: 'goal_not_found',
    };
    const setGoal = vi.fn(async () => runtimeResult);

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => ({
        path: process.cwd(),
        host: 'test-host',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happier',
        happyLibDir: '/tmp/.happier/lib',
        happyToolsDir: '/tmp/.happier/tools',
      } as Metadata),
      sessionRuntimeControls: { setGoal },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({ status: 'paused' }),
    ).resolves.toEqual(runtimeResult);

    expect(setGoal).toHaveBeenCalledWith(undefined, { status: 'paused' });
  });

  it('returns displayable work-state items when metadata preserves future items', async () => {
    const { handlers, registrar } = createRegistrar();
    const metadata = {
      path: process.cwd(),
      host: 'test-host',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happier',
      happyLibDir: '/tmp/.happier/lib',
      happyToolsDir: '/tmp/.happier/tools',
      sessionWorkStateV1: {
        v: 1,
        backendId: 'codex',
        updatedAt: 1,
        primaryItemId: 'goal:thread-1',
        items: [
          {
            id: 'future:1',
            kind: 'milestone',
            origin: 'future',
            status: 'waiting',
            title: 'Future item',
            updatedAt: 1,
          },
          {
            id: 'goal:thread-1',
            kind: 'goal',
            origin: 'vendor',
            status: 'active',
            title: 'Known goal',
            updatedAt: 1,
          },
        ],
      },
    } as Metadata;

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => metadata,
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_WORK_STATE_GET)?.({})).resolves.toEqual({
      workState: {
        v: 1,
        backendId: 'codex',
        updatedAt: 1,
        primaryItemId: 'goal:thread-1',
        items: [
          {
            id: 'goal:thread-1',
            kind: 'goal',
            origin: 'vendor',
            status: 'active',
            title: 'Known goal',
            updatedAt: 1,
          },
        ],
      },
    });
  });

  it('passes through stable unsupported results from runtime goal controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const unsupportedSet = {
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.goal.set',
    };
    const unsupportedGet = {
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.goal.get',
    };
    const unsupportedClear = {
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.goal.clear',
    };

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        refreshGoal: vi.fn(async () => unsupportedGet),
        setGoal: vi.fn(async () => unsupportedSet),
        clearGoal: vi.fn(async () => unsupportedClear),
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_GET)?.({})).resolves.toEqual(unsupportedGet);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({
      objective: 'Unsupported native goal',
    })).resolves.toEqual(unsupportedSet);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR)?.({})).resolves.toEqual(unsupportedClear);
  });

  it('returns unsupported when connected-service auth invalidation controls are unavailable', async () => {
    const { handlers, registrar } = createRegistrar();

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {},
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS)?.({}),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: `unsupported_session_runtime_method:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS}`,
    });
  });

  it('routes connected-service auth apply generation controls to the active runtime', async () => {
    const { handlers, registrar } = createRegistrar();
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      verification: {
        status: 'verified',
        proofStrength: 'exact',
        providerAccountId: 'acct_1',
      },
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        applyConnectedServiceAuthGeneration,
      },
    });

    const request = {
      serviceId: ' openai-codex ',
      reason: 'usage_limit',
      requireDirectLiveHotApply: false,
      expected: {
        profileId: 'profile-old',
        groupId: 'group-1',
        generation: '5',
      },
      authGeneration: {
        kind: 'connected_service_credential',
        profileId: 'profile-new',
      },
    };

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION)?.(request),
    ).resolves.toEqual({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      verification: {
        status: 'verified',
        proofStrength: 'exact',
        providerAccountId: 'acct_1',
      },
    });
    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith({
      ...request,
      serviceId: 'openai-codex',
    });
  });

  it('routes connected-service runtime identity reads without mutating auth', async () => {
    const { handlers, registrar } = createRegistrar();
    const readConnectedServiceRuntimeIdentity = vi.fn(async () => ({
      ok: true,
      serviceId: 'openai-codex',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'exact',
        providerAccountId: 'acct_1',
        source: 'runtime_loaded_credential',
      },
      runtime: {
        safeToApply: false,
        inProviderTurn: true,
      },
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        readConnectedServiceRuntimeIdentity,
      },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY)?.({
        serviceId: ' openai-codex ',
        reason: 'same_provider_account_exhausted',
        requireExactProof: true,
      }),
    ).resolves.toEqual({
      ok: true,
      serviceId: 'openai-codex',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'exact',
        providerAccountId: 'acct_1',
        source: 'runtime_loaded_credential',
      },
      runtime: {
        safeToApply: false,
        inProviderTurn: true,
      },
    });
    expect(readConnectedServiceRuntimeIdentity).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      reason: 'same_provider_account_exhausted',
      requireExactProof: true,
    });
  });

  it('fails closed when connected-service auth apply generation returns malformed exact proof', async () => {
    const { handlers, registrar } = createRegistrar();
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      verification: {
        status: 'verified',
        proofStrength: 'exact',
      },
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        applyConnectedServiceAuthGeneration,
      },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION)?.({
        serviceId: 'openai-codex',
        reason: 'usage_limit',
        authGeneration: {
          kind: 'connected_service_credential',
          profileId: 'profile-new',
        },
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_runtime_control_result',
      error: 'invalid_runtime_control_result',
    });
  });

  it('fails closed when connected-service runtime identity returns malformed exact proof', async () => {
    const { handlers, registrar } = createRegistrar();
    const readConnectedServiceRuntimeIdentity = vi.fn(async () => ({
      ok: true,
      serviceId: 'openai-codex',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'exact',
        source: 'runtime_loaded_credential',
      },
      runtime: {
        safeToApply: true,
      },
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        readConnectedServiceRuntimeIdentity,
      },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY)?.({
        serviceId: 'openai-codex',
        reason: 'same_provider_account_exhausted',
        requireExactProof: true,
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_runtime_control_result',
      error: 'invalid_runtime_control_result',
    });
  });

  it('returns precise unsupported and invalid-parameter results for connected-service runtime controls', async () => {
    const { handlers, registrar } = createRegistrar();

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {},
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION)?.({
        serviceId: 'openai-codex',
        reason: 'usage_limit',
        authGeneration: {
          kind: 'connected_service_credential',
          profileId: 'profile-new',
        },
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: `unsupported_session_runtime_method:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION}`,
    });
    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY)?.({
        serviceId: 'openai-codex',
        reason: 'same_provider_account_exhausted',
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: `unsupported_session_runtime_method:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY}`,
    });
    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION)?.({
        serviceId: '',
        reason: 'usage_limit',
        authGeneration: {
          kind: 'connected_service_credential',
          profileId: 'profile-new',
        },
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION)?.({
        serviceId: 'openai-codex',
        reason: 'usage_limit',
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
  });
});
