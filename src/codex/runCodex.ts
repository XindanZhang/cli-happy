import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { CodexMcpClient } from './codexMcpClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { Credentials, readSettings, updateSettings } from '@/persistence';
import { AgentState, Metadata } from '@/api/types';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import os from 'node:os';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { resolve, join, relative, extname, isAbsolute, sep } from 'node:path';
import fs from 'node:fs';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { trimIdent } from "@/utils/trimIdent";
import type { CodexSessionConfig } from './types';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { delay } from "@/utils/time";
import { stopCaffeinate } from "@/utils/caffeinate";
import { readCodexModelHints } from "./utils/codexConfig";

type PermissionMode = 'default' | 'read-only' | 'safe-yolo' | 'yolo';

type ReadyEventOptions = {
    pending: unknown;
    queueSize: () => number;
    shouldExit: boolean;
    sendReady: () => void;
    notify?: () => void;
};

type ImageAttachParseResult = {
    path: string;
    prompt?: string;
    usedCommand: boolean;
};

const LOCAL_IMAGE_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.bmp',
    '.tif',
    '.tiff',
    '.heic',
    '.heif',
]);

function toPosixPath(pathValue: string): string {
    return pathValue.split(sep).join('/');
}

function stripWrappingQuotes(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length < 2) return trimmed;
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function normalizeDraggedPath(value: string): string {
    let normalized = stripWrappingQuotes(value);
    normalized = normalized.replace(/\\ /g, ' ');
    if (normalized.startsWith('~/') || normalized === '~') {
        const suffix = normalized === '~' ? '' : normalized.slice(1);
        normalized = join(os.homedir(), suffix);
    }
    return normalized;
}

function parseImageAttachInput(messageText: string): ImageAttachParseResult | null {
    const trimmed = messageText.trim();
    if (!trimmed) return null;

    const match = trimmed.match(/^\/(image|img)\b/i);
    if (match) {
        const rest = trimmed.slice(match[0].length).trim();
        const separator = ' -- ';
        const sepIndex = rest.indexOf(separator);
        const pathPart = (sepIndex >= 0 ? rest.slice(0, sepIndex) : rest).trim();
        const promptPart = (sepIndex >= 0 ? rest.slice(sepIndex + separator.length) : '').trim();
        return {
            path: pathPart,
            prompt: promptPart || undefined,
            usedCommand: true,
        };
    }

    // Convenience: allow pasting a single image path and hitting Enter.
    const normalized = normalizeDraggedPath(trimmed);
    const ext = extname(normalized).toLowerCase();
    if (!LOCAL_IMAGE_EXTENSIONS.has(ext)) {
        return null;
    }

    const resolved = isAbsolute(normalized) ? normalized : resolve(process.cwd(), normalized);
    try {
        const stats = fs.statSync(resolved);
        if (!stats.isFile()) return null;
    } catch {
        return null;
    }

    return {
        path: normalized,
        usedCommand: false,
    };
}

function attachLocalImage(rawPath: string, prompt?: string): { prompt: string; referencePath: string; copied: boolean } {
    const normalized = normalizeDraggedPath(rawPath);
    if (!normalized) {
        throw new Error('Missing image path. Usage: /image <path> -- <optional prompt>');
    }

    const resolved = isAbsolute(normalized) ? normalized : resolve(process.cwd(), normalized);
    const stats = fs.statSync(resolved);
    if (!stats.isFile()) {
        throw new Error('Image path is not a file.');
    }

    const ext = extname(resolved).toLowerCase();
    if (!LOCAL_IMAGE_EXTENSIONS.has(ext)) {
        throw new Error(`Unsupported image type "${ext || '(none)'}". Try PNG, JPG, or WEBP.`);
    }

    const cwd = process.cwd();
    const relativeToCwd = relative(cwd, resolved);
    const isInsideWorkspace = relativeToCwd && !relativeToCwd.startsWith('..') && !isAbsolute(relativeToCwd);

    let referencePath: string;
    let copied = false;

    if (isInsideWorkspace) {
        referencePath = relativeToCwd;
    } else {
        const attachmentDir = join(cwd, '.happy-attachments', 'images');
        fs.mkdirSync(attachmentDir, { recursive: true });

        const filename = `image-${Date.now()}-${randomUUID()}${ext}`;
        const destination = join(attachmentDir, filename);
        fs.copyFileSync(resolved, destination);
        referencePath = relative(cwd, destination);
        copied = true;
    }

    let markdownPath = toPosixPath(referencePath);
    if (!markdownPath.startsWith('./') && !markdownPath.startsWith('../')) {
        markdownPath = `./${markdownPath}`;
    }

    const effectivePrompt = prompt?.trim() ? prompt.trim() : 'Describe this image.';
    return {
        prompt: `![](${markdownPath})\n\n${effectivePrompt}`,
        referencePath: markdownPath,
        copied,
    };
}

/**
 * Notify connected clients when Codex finishes processing and the queue is idle.
 * Returns true when a ready event was emitted.
 */
export function emitReadyIfIdle({ pending, queueSize, shouldExit, sendReady, notify }: ReadyEventOptions): boolean {
    if (shouldExit) {
        return false;
    }
    if (pending) {
        return false;
    }
    if (queueSize() > 0) {
        return false;
    }

    sendReady();
    notify?.();
    return true;
}

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    startingMode?: 'local' | 'remote';
    model?: string;
    permissionMode?: PermissionMode;
    profile?: string;
    showSettings?: boolean;
}): Promise<void> {
    interface EnhancedMode {
        permissionMode: PermissionMode;
        model?: string;
        reasoningEffort?: string;
        profile?: string;
    }

    //
    // Define session
    //

    const sessionTag = randomUUID();
    const api = await ApiClient.create(opts.credentials);

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    //
    // Machine
    //

    const settings = await readSettings();
    let machineId = settings?.machineId;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    //
    // Create session
    //

    let state: AgentState = {
        controlledByUser: false,
    }
    let metadata: Metadata = {
        path: process.cwd(),
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: opts.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: opts.startedBy || 'terminal',
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'codex'
    };
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    const session = api.sessionSyncClient(response);

    // Always report to daemon if it exists
    try {
        logger.debug(`[START] Reporting session ${response.id} to daemon`);
        const result = await notifyDaemonSessionStarted(response.id, metadata);
        if (result.error) {
            logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
        } else {
            logger.debug(`[START] Reported session ${response.id} to daemon`);
        }
    } catch (error) {
        logger.debug('[START] Failed to report to daemon (may not be running):', error);
    }

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        reasoningEffort: mode.reasoningEffort,
        profile: mode.profile,
    }));

    // Track current overrides to apply per message
    const persistedPermissionMode = (() => {
        const value = settings?.codex?.permissionMode as PermissionMode | undefined;
        const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
        return value && validModes.includes(value) ? value : undefined;
    })();
    let currentPermissionMode: PermissionMode | undefined = opts.permissionMode ?? persistedPermissionMode;
    let currentModel: string | undefined = opts.model ?? settings?.codex?.model;
    let currentReasoningEffort: string | undefined = settings?.codex?.reasoningEffort;
    let currentProfile: string | undefined = opts.profile ?? settings?.codex?.profile;
    const codexModelHints = readCodexModelHints();

    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let mode: 'local' | 'remote' = opts.startingMode ?? (opts.startedBy === 'daemon' ? 'remote' : 'local');
    if (!hasTTY) {
        mode = 'remote';
    }

    const messageBuffer = new MessageBuffer();
    let inkInstance: any = null;
    let renderRoot: (() => React.ReactElement) | null = null;

    let thinking = false;

    const rerender = () => {
        if (renderRoot && inkInstance?.rerender) {
            inkInstance.rerender(renderRoot());
        }
    };

    const setMode = async (next: 'local' | 'remote', reason?: string) => {
        if (!hasTTY) {
            // Without a TTY there is nothing to "switch" to locally.
            mode = 'remote';
            return;
        }
        if (next === mode) {
            return;
        }

        mode = next;

        if (reason) {
            messageBuffer.addMessage(reason, 'status');
        }

        session.sendSessionEvent({ type: 'switch', mode });
        session.updateAgentState((currentState) => ({
            ...currentState,
            controlledByUser: mode === 'local'
        }));
        session.keepAlive(thinking, mode);
        rerender();
    };

    session.onUserMessage((message) => {
        const sentFrom = message.meta?.sentFrom;

        // Ignore local terminal messages echoed back from the server; we already enqueued them.
        if (sentFrom === 'terminal') {
            return;
        }

        // If the user is typing in the terminal and a mobile message arrives,
        // switch to remote mode to mirror Claude's "mobile takes over" behavior.
        if (hasTTY && mode === 'local') {
            void setMode('remote', 'Mobile message received • switched to remote mode');
        }

        // Resolve permission mode (validate)
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
            if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
                messagePermissionMode = message.meta.permissionMode as PermissionMode;
                currentPermissionMode = messagePermissionMode;
                logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
            } else {
                logger.debug(`[Codex] Invalid permission mode received: ${message.meta.permissionMode}`);
            }
        } else {
            logger.debug(`[Codex] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
        }

        // Resolve model; explicit null resets to default (undefined)
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined;
            currentModel = messageModel;
            logger.debug(`[Codex] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[Codex] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        // Resolve reasoning effort; explicit null resets to default (undefined)
        let messageReasoningEffort = currentReasoningEffort;
        const metaAny: any = message.meta as any;
        if (metaAny && (Object.prototype.hasOwnProperty.call(metaAny, 'reasoningEffort')
            || Object.prototype.hasOwnProperty.call(metaAny, 'model_reasoning_effort')
            || Object.prototype.hasOwnProperty.call(metaAny, 'modelReasoningEffort'))) {
            messageReasoningEffort = metaAny.reasoningEffort || metaAny.model_reasoning_effort || metaAny.modelReasoningEffort || undefined;
            currentReasoningEffort = messageReasoningEffort;
            logger.debug(`[Codex] Reasoning effort updated from user message: ${messageReasoningEffort || 'reset to default'}`);
        } else {
            logger.debug(`[Codex] User message received with no reasoning effort override, using current: ${currentReasoningEffort || 'default'}`);
        }

        // Resolve profile; explicit null resets to default (undefined)
        let messageProfile = currentProfile;
        if (message.meta?.hasOwnProperty('profile')) {
            messageProfile = (message.meta as any).profile || undefined;
            currentProfile = messageProfile;
            logger.debug(`[Codex] Profile updated from user message: ${messageProfile || 'reset to default'}`);
        } else {
            logger.debug(`[Codex] User message received with no profile override, using current: ${currentProfile || 'default'}`);
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
            reasoningEffort: messageReasoningEffort,
            profile: messageProfile,
        };
        messageQueue.push(message.content.text, enhancedMode);
    });

    // Set initial agent state for the UI/app.
    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: mode === 'local'
    }));

    session.keepAlive(thinking, mode);
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, mode);
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
        try {
            api.push().sendToAllDevices(
                "It's ready!",
                'Codex is waiting for your command',
                { sessionId: session.sessionId }
            );
        } catch (pushError) {
            logger.debug('[Codex] Failed to send ready push', pushError);
        }
    };

    // Debug helper: log active handles/requests if DEBUG is enabled
    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const anyProc: any = process as any;
        const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
        const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        try {
            const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
            logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
        } catch { }
    }

    //
    // Abort handling
    // IMPORTANT: There are two different operations:
    // 1. Abort (handleAbort): Stops the current inference/task but keeps the session alive
    //    - Used by the 'abort' RPC from mobile app
    //    - Similar to Claude Code's abort behavior
    //    - Allows continuing with new prompts after aborting
    // 2. Kill (handleKillSession): Terminates the entire process
    //    - Used by the 'killSession' RPC
    //    - Completely exits the CLI process
    //

    let abortController = new AbortController();
    let shouldExit = false;
    let storedSessionIdForResume: string | null = null;

    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            // Store the current session ID before aborting for potential resume
            if (client.hasActiveSession()) {
                storedSessionIdForResume = client.storeSessionForResume();
                logger.debug('[Codex] Stored session for resume:', storedSessionIdForResume);
            }
            
            abortController.abort();
            messageQueue.reset();
            permissionHandler.reset();
            reasoningProcessor.abort();
            diffProcessor.reset();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            abortController = new AbortController();
        }
    }

    /**
     * Handles session termination and process exit.
     * This is called when the session needs to be completely killed (not just aborted).
     * Abort stops the current inference but keeps the session alive.
     * Kill terminates the entire process.
     */
    const handleKillSession = async () => {
        logger.debug('[Codex] Kill session requested - terminating process');
        await handleAbort();
        logger.debug('[Codex] Abort completed, proceeding with termination');

        try {
            // Update lifecycle state to archived before closing
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));
                
                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Stop caffeinate
            stopCaffeinate();

            // Stop Happy MCP server
            happyServer.stop();

            logger.debug('[Codex] Session termination complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[Codex] Error during session termination:', error);
            process.exit(1);
        }
    };

    // Register abort handler
    session.rpcHandlerManager.registerHandler('abort', handleAbort);

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    //
    // Initialize Ink UI
    //

    if (hasTTY) {
        console.clear();
        const defaults: string[] = [];
        defaults.push(`mode=${mode}`);
        if (currentModel) defaults.push(`model=${currentModel}`);
        if (currentPermissionMode) defaults.push(`permission-mode=${currentPermissionMode}`);
        if (currentReasoningEffort) defaults.push(`thinking=${currentReasoningEffort}`);
        if (currentProfile) defaults.push(`profile=${currentProfile}`);
        if (defaults.length > 0) {
            messageBuffer.addMessage(`Defaults: ${defaults.join(' ')}`, 'system');
        }

        const initialShowSettings = (opts.startedBy || 'terminal') === 'terminal'
            && (opts.showSettings || (!settings?.codex?.configured && !opts.model && !opts.permissionMode && !opts.profile));

        renderRoot = () => React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            mode,
            settings: {
                model: currentModel,
                permissionMode: currentPermissionMode,
                reasoningEffort: currentReasoningEffort,
                profile: currentProfile,
            },
            modelHints: codexModelHints,
            initialShowSettings,
            onSwitchToLocal: async () => {
                await setMode('local', 'Switched to local mode');
            },
            onSwitchToRemote: async () => {
                await setMode('remote', 'Switched to remote mode');
            },
            onSubmitPrompt: async (prompt) => {
                let messageText = prompt.trim();
                if (!messageText) {
                    return;
                }

                const imageInput = parseImageAttachInput(messageText);
                if (imageInput) {
                    try {
                        const attached = attachLocalImage(imageInput.path, imageInput.prompt);
                        messageText = attached.prompt;
                        messageBuffer.addMessage(
                            attached.copied
                                ? `Attached image (copied into workspace): ${attached.referencePath}`
                                : `Attached image: ${attached.referencePath}`,
                            'status'
                        );
                    } catch (error) {
                        const reason = error instanceof Error ? error.message : 'Unknown error';
                        messageBuffer.addMessage(`Failed to attach image: ${reason}`, 'system');
                        return;
                    }
                }

                // Ensure we are in local mode when typing from the terminal.
                await setMode('local');

                const enhancedMode: EnhancedMode = {
                    permissionMode: currentPermissionMode || 'default',
                    model: currentModel,
                    reasoningEffort: currentReasoningEffort,
                    profile: currentProfile,
                };

                // Queue for processing by Codex.
                messageQueue.pushImmediate(messageText, enhancedMode);

                // Mirror to the server so the mobile app stays in sync.
                session.sendUserMessage(messageText, {
                    sentFrom: 'terminal',
                    permissionMode: enhancedMode.permissionMode,
                    model: enhancedMode.model ?? undefined,
                });
            },
            onUpdateSettings: async (next) => {
                // Update runtime defaults
                currentModel = next.model;
                currentPermissionMode = next.permissionMode;
                currentReasoningEffort = next.reasoningEffort;
                currentProfile = next.profile;

                // Persist defaults for future runs
                await updateSettings((current) => ({
                    ...current,
                    codex: {
                        ...current.codex,
                        configured: true,
                        model: next.model,
                        permissionMode: next.permissionMode,
                        reasoningEffort: next.reasoningEffort,
                        profile: next.profile,
                    }
                }));

                const updatedDefaults: string[] = [];
                if (currentModel) updatedDefaults.push(`model=${currentModel}`);
                if (currentPermissionMode) updatedDefaults.push(`permission-mode=${currentPermissionMode}`);
                if (currentReasoningEffort) updatedDefaults.push(`thinking=${currentReasoningEffort}`);
                if (currentProfile) updatedDefaults.push(`profile=${currentProfile}`);
                if (updatedDefaults.length > 0) {
                    messageBuffer.addMessage(`Defaults updated: ${updatedDefaults.join(' ')}`, 'system');
                } else {
                    messageBuffer.addMessage('Defaults updated: (Codex config defaults)', 'system');
                }

                // Refresh UI props for the next time settings are opened
                rerender();
            },
            onExit: async () => {
                // Exit the agent
                logger.debug('[codex]: Exiting agent via Ctrl-C');
                shouldExit = true;
                await handleAbort();
            }
        });

        inkInstance = render(renderRoot(), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    //
    // Start Context 
    //

    const client = new CodexMcpClient();

    // Helper: find Codex session transcript for a given sessionId
    function findCodexResumeFile(sessionId: string | null): string | null {
        if (!sessionId) return null;
        try {
            const codexHomeDir = process.env.CODEX_HOME || join(os.homedir(), '.codex');
            const rootDir = join(codexHomeDir, 'sessions');

            // Recursively collect all files under the sessions directory
            function collectFilesRecursive(dir: string, acc: string[] = []): string[] {
                let entries: fs.Dirent[];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch {
                    return acc;
                }
                for (const entry of entries) {
                    const full = join(dir, entry.name);
                    if (entry.isDirectory()) {
                        collectFilesRecursive(full, acc);
                    } else if (entry.isFile()) {
                        acc.push(full);
                    }
                }
                return acc;
            }

            const candidates = collectFilesRecursive(rootDir)
                .filter(full => full.endsWith(`-${sessionId}.jsonl`))
                .filter(full => {
                    try { return fs.statSync(full).isFile(); } catch { return false; }
                })
                .sort((a, b) => {
                    const sa = fs.statSync(a).mtimeMs;
                    const sb = fs.statSync(b).mtimeMs;
                    return sb - sa; // newest first
                });
            return candidates[0] || null;
        } catch {
            return null;
        }
    }
    const permissionHandler = new CodexPermissionHandler(session);
    const reasoningProcessor = new ReasoningProcessor((message) => {
        // Callback to send messages directly from the processor
        session.sendCodexMessage(message);
    });
    const diffProcessor = new DiffProcessor((message) => {
        // Callback to send messages directly from the processor
        session.sendCodexMessage(message);
    });
    client.setPermissionHandler(permissionHandler);
    client.setHandler((msg) => {
        logger.debug(`[Codex] MCP message: ${JSON.stringify(msg)}`);

        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message') {
            messageBuffer.addMessage(msg.message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning') {
            messageBuffer.addMessage(`[Thinking] ${msg.text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${msg.command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = msg.output || msg.error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            messageBuffer.addMessage('Task completed', 'status');
            sendReady();
        } else if (msg.type === 'turn_aborted') {
            messageBuffer.addMessage('Turn aborted', 'status');
            sendReady();
        }

        if (msg.type === 'task_started') {
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                session.keepAlive(thinking, mode);
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, mode);
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
        }
        if (msg.type === 'agent_reasoning_section_break') {
            // Reset reasoning processor for new section
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta') {
            // Process reasoning delta - tool calls are sent automatically via callback
            reasoningProcessor.processDelta(msg.delta);
        }
        if (msg.type === 'agent_reasoning') {
            // Complete the reasoning section - tool results or reasoning messages sent via callback
            reasoningProcessor.complete(msg.text);
        }
        if (msg.type === 'agent_message') {
            session.sendCodexMessage({
                type: 'message',
                message: msg.message,
                id: randomUUID()
            });
        }
        if (msg.type === 'exec_command_begin' || msg.type === 'exec_approval_request') {
            let { call_id, type, ...inputs } = msg;
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexBash',
                callId: call_id,
                input: inputs,
                id: randomUUID()
            });
        }
        if (msg.type === 'exec_command_end') {
            let { call_id, type, ...output } = msg;
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId: call_id,
                output: output,
                id: randomUUID()
            });
        }
        if (msg.type === 'token_count') {
            session.sendCodexMessage({
                ...msg,
                id: randomUUID()
            });
        }
        if (msg.type === 'patch_apply_begin') {
            // Handle the start of a patch operation
            let { call_id, auto_approved, changes } = msg;

            // Add UI feedback for patch operation
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');

            // Send tool call message
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexPatch',
                callId: call_id,
                input: {
                    auto_approved,
                    changes
                },
                id: randomUUID()
            });
        }
        if (msg.type === 'patch_apply_end') {
            // Handle the end of a patch operation
            let { call_id, stdout, stderr, success } = msg;

            // Add UI feedback for completion
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }

            // Send tool call result message
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId: call_id,
                output: {
                    stdout,
                    stderr,
                    success
                },
                id: randomUUID()
            });
        }
        if (msg.type === 'turn_diff') {
            // Handle turn_diff messages and track unified_diff changes
            if (msg.unified_diff) {
                diffProcessor.processDiff(msg.unified_diff);
            }
        }
    });

    // Start Happy MCP server (HTTP) and prepare STDIO bridge config for Codex
    const happyServer = await startHappyServer(session);
    const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
    const mcpServers = {
        happy: {
            command: bridgeCommand,
            args: ['--url', happyServer.url]
        }
    } as const;
    let first = true;

    try {
        logger.debug('[codex]: client.connect begin');
        await client.connect();
        logger.debug('[codex]: client.connect done');
        let wasCreated = false;
        let currentModeHash: string | null = null;
        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;
        // If we restart (e.g., mode change), use this to carry a resume file
        let nextExperimentalResume: string | null = null;

        while (!shouldExit) {
            logActiveHandles('loop-top');
            // Get next batch; respect mode boundaries like Claude
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
            pending = null;
            if (!message) {
                // Capture the current signal to distinguish idle-abort from queue close
                const waitSignal = abortController.signal;
                const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    // If wait was aborted (e.g., remote abort with no active inference), ignore and continue
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            // Defensive check for TS narrowing
            if (!message) {
                break;
            }

            // If a session exists and mode changed, restart on next iteration
            if (wasCreated && currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[Codex] Mode changed – restarting Codex session');
                messageBuffer.addMessage('═'.repeat(40), 'status');
                messageBuffer.addMessage('Starting new Codex session (mode changed)...', 'status');
                // Capture previous sessionId and try to find its transcript to resume
                try {
                    const prevSessionId = client.getSessionId();
                    nextExperimentalResume = findCodexResumeFile(prevSessionId);
                    if (nextExperimentalResume) {
                        logger.debug(`[Codex] Found resume file for session ${prevSessionId}: ${nextExperimentalResume}`);
                        messageBuffer.addMessage('Resuming previous context…', 'status');
                    } else {
                        logger.debug('[Codex] No resume file found for previous session');
                    }
                } catch (e) {
                    logger.debug('[Codex] Error while searching resume file', e);
                }
                client.clearSession();
                wasCreated = false;
                currentModeHash = null;
                pending = message;
                // Reset processors/permissions like end-of-turn cleanup
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, mode);
                continue;
            }

            // Display user messages in the UI
            messageBuffer.addMessage(message.message, 'user');
            currentModeHash = message.hash;

            try {
                // Map permission mode to approval policy and sandbox for startSession
                const approvalPolicy = (() => {
                    switch (message.mode.permissionMode) {
                        case 'default': return 'untrusted' as const;
                        case 'read-only': return 'never' as const;
                        case 'safe-yolo': return 'on-failure' as const;
                        case 'yolo': return 'never' as const;
                    }
                })();
                const sandbox = (() => {
                    switch (message.mode.permissionMode) {
                        case 'default': return 'workspace-write' as const;
                        case 'read-only': return 'read-only' as const;
                        case 'safe-yolo': return 'workspace-write' as const;
                        case 'yolo': return 'danger-full-access' as const;
                    }
                })();

                permissionHandler.setPermissionMode(message.mode.permissionMode);

                if (!wasCreated) {
                    const startConfig: CodexSessionConfig = {
                        prompt: first ? message.message + '\n\n' + CHANGE_TITLE_INSTRUCTION : message.message,
                        sandbox,
                        'approval-policy': approvalPolicy,
                        config: { mcp_servers: mcpServers }
                    };
                    if (message.mode.model) {
                        startConfig.model = message.mode.model;
                    }
                    if (message.mode.reasoningEffort) {
                        (startConfig.config as any).model_reasoning_effort = message.mode.reasoningEffort;
                    }
                    if (message.mode.profile) {
                        startConfig.profile = message.mode.profile;
                    }
                    
                    // Check for resume file from multiple sources
                    let resumeFile: string | null = null;
                    
                    // Priority 1: Explicit resume file from mode change
                    if (nextExperimentalResume) {
                        resumeFile = nextExperimentalResume;
                        nextExperimentalResume = null; // consume once
                        logger.debug('[Codex] Using resume file from mode change:', resumeFile);
                    }
                    // Priority 2: Resume from stored abort session
                    else if (storedSessionIdForResume) {
                        const abortResumeFile = findCodexResumeFile(storedSessionIdForResume);
                        if (abortResumeFile) {
                            resumeFile = abortResumeFile;
                            logger.debug('[Codex] Using resume file from aborted session:', resumeFile);
                            messageBuffer.addMessage('Resuming from aborted session...', 'status');
                        }
                        storedSessionIdForResume = null; // consume once
                    }
                    
                    // Apply resume file if found
                    if (resumeFile) {
                        (startConfig.config as any).experimental_resume = resumeFile;
                    }
                    
                    await client.startSession(
                        startConfig,
                        { signal: abortController.signal }
                    );
                    wasCreated = true;
                    first = false;
                } else {
                    const response = await client.continueSession(
                        message.message,
                        { signal: abortController.signal }
                    );
                    logger.debug('[Codex] continueSession response:', response);
                }
            } catch (error) {
                logger.warn('Error in codex session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';
                
                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    // Session was already stored in handleAbort(), no need to store again
                    // Mark session as not created to force proper resume on next message
                    wasCreated = false;
                    currentModeHash = null;
                    logger.debug('[Codex] Marked session as not created after abort for proper resume');
                } else {
                    messageBuffer.addMessage('Process exited unexpectedly', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    // For unexpected exits, try to store session for potential recovery
                    if (client.hasActiveSession()) {
                        storedSessionIdForResume = client.storeSessionForResume();
                        logger.debug('[Codex] Stored session after unexpected error:', storedSessionIdForResume);
                    }
                }
            } finally {
                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.reset();
                reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, mode);
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                logActiveHandles('after-turn');
            }
        }

    } finally {
        // Clean up resources when main loop exits
        logger.debug('[codex]: Final cleanup start');
        logActiveHandles('cleanup-start');
        try {
            logger.debug('[codex]: sendSessionDeath');
            session.sendSessionDeath();
            logger.debug('[codex]: flush begin');
            await session.flush();
            logger.debug('[codex]: flush done');
            logger.debug('[codex]: session.close begin');
            await session.close();
            logger.debug('[codex]: session.close done');
        } catch (e) {
            logger.debug('[codex]: Error while closing session', e);
        }
        logger.debug('[codex]: client.disconnect begin');
        await client.disconnect();
        logger.debug('[codex]: client.disconnect done');
        // Stop Happy MCP server
        logger.debug('[codex]: happyServer.stop');
        happyServer.stop();

        // Clean up ink UI
        if (process.stdin.isTTY) {
            logger.debug('[codex]: setRawMode(false)');
            try { process.stdin.setRawMode(false); } catch { }
        }
        // Stop reading from stdin so the process can exit
        if (hasTTY) {
            logger.debug('[codex]: stdin.pause()');
            try { process.stdin.pause(); } catch { }
        }
        // Clear periodic keep-alive to avoid keeping event loop alive
        logger.debug('[codex]: clearInterval(keepAlive)');
        clearInterval(keepAliveInterval);
        if (inkInstance) {
            logger.debug('[codex]: inkInstance.unmount()');
            inkInstance.unmount();
        }
        messageBuffer.clear();

        logActiveHandles('cleanup-end');
        logger.debug('[codex]: Final cleanup completed');
    }
}
