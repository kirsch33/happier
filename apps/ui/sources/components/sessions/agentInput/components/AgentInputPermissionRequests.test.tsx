import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { AgentInputAttentionRequests as AgentInputAttentionRequestsComponent } from './AgentInputPermissionRequests';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const capturedPermissionPromptCardProps: Array<Record<string, unknown>> = [];
const capturedUserActionPromptCardProps: Array<Record<string, unknown>> = [];
const capturedApprovalPromptCardProps: Array<Record<string, unknown>> = [];

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
        ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
        Platform: {
            OS: 'web',
            select: (value: any) => value.web ?? value.default ?? null,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                divider: '#ddd',
                surfaceHighest: '#fff',
                input: { background: '#f7f7f7' },
                textSecondary: '#666',
            },
        },
    });
});

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: () => null,
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: () => null,
}));

vi.mock('@/components/tools/shell/permissions/PermissionPromptCard', () => ({
    PermissionPromptCard: (props: any) => {
        capturedPermissionPromptCardProps.push(props);
        return React.createElement('PermissionPromptCard', props);
    },
}));

vi.mock('@/components/tools/shell/userActions/UserActionPromptCard', () => ({
    UserActionPromptCard: (props: any) => {
        capturedUserActionPromptCardProps.push(props);
        return React.createElement('UserActionPromptCard', props);
    },
}));

vi.mock('@/components/tools/shell/approvals/ApprovalPromptCard', () => ({
    ApprovalPromptCard: (props: any) => {
        capturedApprovalPromptCardProps.push(props);
        return React.createElement('ApprovalPromptCard', props);
    },
}));

function approvalArtifact(id = 'a1'): DecryptedArtifact {
    return {
        id,
        header: { kind: 'approval_request.v1', title: 'Approval', approvalStatus: 'open', sessionId: 's1' },
        title: 'Approval',
        body: null,
        headerVersion: 1,
        bodyVersion: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        isDecrypted: true,
    };
}

describe('AgentInputAttentionRequests', () => {
    it('renders a single outer chrome wrapper for permissions and approvals with dividers', async () => {
        const { AgentInputAttentionRequests } = await import('./AgentInputPermissionRequests');
        capturedPermissionPromptCardProps.length = 0;
        capturedUserActionPromptCardProps.length = 0;
        capturedApprovalPromptCardProps.length = 0;

        const screen = await renderScreen(React.createElement(AgentInputAttentionRequests, {
            sessionId: 's1',
            permissionRequests: [
                { id: 'p1', kind: 'permission', tool: 'execute', arguments: { command: 'pwd' }, createdAt: null },
                { id: 'p2', kind: 'permission', tool: 'execute', arguments: { command: 'ls' }, createdAt: null },
            ],
            approvalRequests: [
                {
                    artifact: approvalArtifact('a1'),
                    approval: {
                        v: 1,
                        status: 'open',
                        createdAtMs: 1,
                        updatedAtMs: 1,
                        createdBy: { surface: 'session_agent', sessionId: 's1' },
                        actionId: 'session.list',
                        actionArgs: {},
                        summary: 'List sessions',
                    },
                },
            ],
            permissionLocationsById: new Map(),
            metadata: null,
            canApprovePermissions: true,
            maxHeightPx: 200,
            onContentSizeChange: () => {},
            onLayout: () => {},
            onScroll: () => {},
            fadeVisibility: { top: false, bottom: false },
        } satisfies React.ComponentProps<typeof AgentInputAttentionRequestsComponent>));

        expect(screen.findByTestId('agentInput.permissionRequests.chrome')).toBeTruthy();

        expect(capturedPermissionPromptCardProps).toHaveLength(2);
        expect(capturedUserActionPromptCardProps).toHaveLength(0);
        expect(capturedApprovalPromptCardProps).toHaveLength(1);
        expect(capturedPermissionPromptCardProps[0].chrome).toBe('inline');
        expect(capturedApprovalPromptCardProps[0].chrome).toBe('inline');

        expect(screen.findByTestId('agentInput.permissionRequests.divider:permission:p2')).toBeTruthy();
        expect(screen.findByTestId('agentInput.permissionRequests.divider:approval:a1')).toBeTruthy();
    });

    it('renders live user-action requests as inline prompt cards', async () => {
        const { AgentInputAttentionRequests } = await import('./AgentInputPermissionRequests');
        const UntypedAgentInputAttentionRequests = AgentInputAttentionRequests as React.ComponentType<any>;
        capturedPermissionPromptCardProps.length = 0;
        capturedUserActionPromptCardProps.length = 0;
        capturedApprovalPromptCardProps.length = 0;

        const screen = await renderScreen(React.createElement(UntypedAgentInputAttentionRequests, {
            sessionId: 's1',
            permissionRequests: [],
            userActionRequests: [
                {
                    id: 'resume_choice',
                    kind: 'user_action',
                    tool: 'AskUserQuestion',
                    arguments: {
                        questions: [{
                            header: 'Claude resume',
                            question: 'How should Claude resume this session?',
                            options: [
                                { label: 'Resume from summary', description: 'Use the saved summary.' },
                                { label: 'Resume full session', description: 'Load full context.' },
                            ],
                            multiSelect: false,
                        }],
                    },
                    createdAt: null,
                },
            ],
            approvalRequests: [],
            permissionLocationsById: new Map([
                ['resume_choice', { kind: 'top' as const, messageId: 'tool:question-1', seq: 11 }],
            ]),
            metadata: null,
            canApprovePermissions: true,
            maxHeightPx: 200,
            onContentSizeChange: () => {},
            onLayout: () => {},
            onScroll: () => {},
            fadeVisibility: { top: false, bottom: false },
        }));

        expect(screen.findByTestId('agentInput.permissionRequests.chrome')).toBeTruthy();
        expect(capturedPermissionPromptCardProps).toHaveLength(0);
        expect(capturedUserActionPromptCardProps).toHaveLength(1);
        expect(capturedUserActionPromptCardProps[0].chrome).toBe('inline');
        expect(capturedUserActionPromptCardProps[0].location).toEqual({ kind: 'top', messageId: 'tool:question-1', seq: 11 });
        expect(capturedApprovalPromptCardProps).toHaveLength(0);
    });

    it('passes resolved tool locations to approval prompt cards', async () => {
        const { AgentInputAttentionRequests } = await import('./AgentInputPermissionRequests');
        capturedApprovalPromptCardProps.length = 0;

        await renderScreen(React.createElement(AgentInputAttentionRequests, {
            sessionId: 's1',
            permissionRequests: [],
            approvalRequests: [
                {
                    artifact: approvalArtifact('a1'),
                    approval: {
                        v: 1,
                        status: 'open',
                        createdAtMs: 1,
                        updatedAtMs: 1,
                        createdBy: { surface: 'session_agent', sessionId: 's1' },
                        actionId: 'session.list',
                        actionArgs: {},
                        summary: 'List sessions',
                    },
                },
            ],
            permissionLocationsById: new Map(),
            approvalLocationsByArtifactId: new Map([
                ['a1', { kind: 'top' as const, messageId: 'tool:call-1', seq: 10 }],
            ]),
            metadata: null,
            canApprovePermissions: true,
            maxHeightPx: 200,
            onContentSizeChange: () => {},
            onLayout: () => {},
            onScroll: () => {},
            fadeVisibility: { top: false, bottom: false },
        } satisfies React.ComponentProps<typeof AgentInputAttentionRequestsComponent>));

        expect(capturedApprovalPromptCardProps).toHaveLength(1);
        expect(capturedApprovalPromptCardProps[0].location).toEqual({ kind: 'top', messageId: 'tool:call-1', seq: 10 });
    });

    it('does not render provider permissions or approvals when approvals are disabled due to inactive session', async () => {
        const { AgentInputAttentionRequests } = await import('./AgentInputPermissionRequests');
        capturedPermissionPromptCardProps.length = 0;
        capturedUserActionPromptCardProps.length = 0;
        capturedApprovalPromptCardProps.length = 0;

        const screen = await renderScreen(React.createElement(AgentInputAttentionRequests, {
            sessionId: 's1',
            permissionRequests: [
                { id: 'p1', kind: 'permission', tool: 'execute', arguments: { command: 'pwd' }, createdAt: null },
            ],
            approvalRequests: [
                {
                    artifact: approvalArtifact('a1'),
                    approval: {
                        v: 1,
                        status: 'open',
                        createdAtMs: 1,
                        updatedAtMs: 1,
                        createdBy: { surface: 'session_agent', sessionId: 's1' },
                        actionId: 'session.list',
                        actionArgs: {},
                        summary: 'List sessions',
                    },
                },
            ],
            permissionLocationsById: new Map(),
            metadata: null,
            canApprovePermissions: false,
            disabledReason: 'inactive',
            maxHeightPx: 200,
            onContentSizeChange: () => {},
            onLayout: () => {},
            onScroll: () => {},
            fadeVisibility: { top: false, bottom: false },
        } satisfies React.ComponentProps<typeof AgentInputAttentionRequestsComponent>));

        expect(screen.findByTestId('agentInput.permissionRequests.chrome')).toBeNull();
        expect(capturedPermissionPromptCardProps).toHaveLength(0);
        expect(capturedUserActionPromptCardProps).toHaveLength(0);
        expect(capturedApprovalPromptCardProps).toHaveLength(0);
    });

    it('does not render live user-action requests when permission approvals are inactive', async () => {
        const { AgentInputAttentionRequests } = await import('./AgentInputPermissionRequests');
        const UntypedAgentInputAttentionRequests = AgentInputAttentionRequests as React.ComponentType<any>;
        capturedPermissionPromptCardProps.length = 0;
        capturedUserActionPromptCardProps.length = 0;
        capturedApprovalPromptCardProps.length = 0;

        const screen = await renderScreen(React.createElement(UntypedAgentInputAttentionRequests, {
            sessionId: 's1',
            permissionRequests: [
                { id: 'p1', kind: 'permission', tool: 'execute', arguments: { command: 'pwd' }, createdAt: null },
            ],
            userActionRequests: [
                {
                    id: 'resume_choice',
                    kind: 'user_action',
                    tool: 'AskUserQuestion',
                    arguments: {
                        questions: [{
                            header: 'Claude resume',
                            question: 'How should Claude resume this session?',
                            options: [
                                { label: 'Resume from summary', description: 'Use the saved summary.' },
                                { label: 'Resume full session', description: 'Load full context.' },
                            ],
                            multiSelect: false,
                        }],
                    },
                    createdAt: null,
                },
            ],
            approvalRequests: [
                {
                    artifact: approvalArtifact('a1'),
                    approval: {
                        v: 1,
                        status: 'open',
                        createdAtMs: 1,
                        updatedAtMs: 1,
                        createdBy: { surface: 'session_agent', sessionId: 's1' },
                        actionId: 'session.list',
                        actionArgs: {},
                        summary: 'List sessions',
                    },
                },
            ],
            permissionLocationsById: new Map(),
            metadata: null,
            canApprovePermissions: false,
            disabledReason: 'inactive',
            maxHeightPx: 200,
            onContentSizeChange: () => {},
            onLayout: () => {},
            onScroll: () => {},
            fadeVisibility: { top: false, bottom: false },
        }));

        expect(screen.findByTestId('agentInput.permissionRequests.chrome')).toBeNull();
        expect(capturedPermissionPromptCardProps).toHaveLength(0);
        expect(capturedUserActionPromptCardProps).toHaveLength(0);
        expect(capturedApprovalPromptCardProps).toHaveLength(0);
    });

    it('does not render permission requests when the session is inactive even if canApprovePermissions is incorrectly true', async () => {
        const { AgentInputAttentionRequests } = await import('./AgentInputPermissionRequests');
        capturedPermissionPromptCardProps.length = 0;
        capturedUserActionPromptCardProps.length = 0;
        capturedApprovalPromptCardProps.length = 0;

        const screen = await renderScreen(React.createElement(AgentInputAttentionRequests, {
            sessionId: 's1',
            permissionRequests: [
                { id: 'p1', kind: 'permission', tool: 'mcp__playwright__browser_close', arguments: {}, createdAt: null },
            ],
            approvalRequests: [],
            permissionLocationsById: new Map(),
            metadata: null,
            canApprovePermissions: true,
            disabledReason: 'inactive',
            maxHeightPx: 200,
            onContentSizeChange: () => {},
            onLayout: () => {},
            onScroll: () => {},
            fadeVisibility: { top: false, bottom: false },
        } satisfies React.ComponentProps<typeof AgentInputAttentionRequestsComponent>));

        expect(screen.findByTestId('agentInput.permissionRequests.chrome')).toBeNull();
        expect(capturedPermissionPromptCardProps).toHaveLength(0);
    });

    it('renders legacy AskUserQuestion user actions without an explicit user action kind', async () => {
        const { AgentInputAttentionRequests } = await import('./AgentInputPermissionRequests');
        const UntypedAgentInputAttentionRequests = AgentInputAttentionRequests as React.ComponentType<any>;
        capturedPermissionPromptCardProps.length = 0;
        capturedUserActionPromptCardProps.length = 0;
        capturedApprovalPromptCardProps.length = 0;
        const legacyUserActionRequests = [
            { id: 'u1', tool: 'AskUserQuestion', arguments: { question: 'Continue?' }, createdAt: null },
        ];

        const screen = await renderScreen(React.createElement(UntypedAgentInputAttentionRequests, {
            sessionId: 's1',
            permissionRequests: [],
            // Malformed persisted legacy fixture intentionally violates the current request type.
            userActionRequests: legacyUserActionRequests,
            approvalRequests: [],
            permissionLocationsById: new Map(),
            metadata: null,
            canApprovePermissions: true,
            maxHeightPx: 200,
            onContentSizeChange: () => {},
            onLayout: () => {},
            onScroll: () => {},
            fadeVisibility: { top: false, bottom: false },
        }));

        expect(screen.findByTestId('agentInput.permissionRequests.chrome')).toBeTruthy();
        expect(capturedUserActionPromptCardProps).toHaveLength(1);
    });
});
