import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Box, Text, useStdout, useInput } from 'ink'
import { MessageBuffer, type BufferedMessage } from './messageBuffer'

type PermissionMode = 'default' | 'read-only' | 'safe-yolo' | 'yolo'

type CodexSettings = {
    model?: string
    permissionMode?: PermissionMode
    profile?: string
}

interface CodexDisplayProps {
    messageBuffer: MessageBuffer
    logPath?: string
    onExit?: () => void
    settings?: CodexSettings
    initialShowSettings?: boolean
    onUpdateSettings?: (settings: CodexSettings) => void | Promise<void>
}

export const CodexDisplay: React.FC<CodexDisplayProps> = ({
    messageBuffer,
    logPath,
    onExit,
    settings,
    initialShowSettings,
    onUpdateSettings,
}) => {
    const [messages, setMessages] = useState<BufferedMessage[]>([])
    const [confirmationMode, setConfirmationMode] = useState<boolean>(false)
    const [actionInProgress, setActionInProgress] = useState<boolean>(false)
    const [actionLabel, setActionLabel] = useState<string | null>(null)
    const confirmationTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const { stdout } = useStdout()
    const terminalWidth = stdout.columns || 80
    const terminalHeight = stdout.rows || 24

    const [settingsOpen, setSettingsOpen] = useState<boolean>(() => Boolean(initialShowSettings))
    const [settingsSelection, setSettingsSelection] = useState<number>(0)
    const [editingField, setEditingField] = useState<'model' | 'profile' | null>(null)
    const [draftPermissionMode, setDraftPermissionMode] = useState<PermissionMode>(() => settings?.permissionMode || 'default')
    const [draftModel, setDraftModel] = useState<string>(() => settings?.model || '')
    const [draftProfile, setDraftProfile] = useState<string>(() => settings?.profile || '')
    const [draftTextInput, setDraftTextInput] = useState<string>('')

    const permissionModeOptions: Array<{ value: PermissionMode; label: string; description: string }> = [
        {
            value: 'default',
            label: 'default',
            description: 'Asks for permission for most actions (recommended).'
        },
        {
            value: 'read-only',
            label: 'read-only',
            description: 'Read-only sandbox; write actions should fail.'
        },
        {
            value: 'safe-yolo',
            label: 'safe-yolo',
            description: 'Runs without prompting in a sandbox; may still ask to escalate on failure.'
        },
        {
            value: 'yolo',
            label: 'yolo',
            description: 'Full access: no sandbox and no approval prompts.'
        }
    ]

    const settingsItems = [
        { key: 'permissionMode' as const, label: 'Permission mode' },
        { key: 'model' as const, label: 'Model' },
        { key: 'profile' as const, label: 'Profile' },
        { key: 'save' as const, label: 'Save & close' },
        { key: 'cancel' as const, label: 'Cancel' },
    ]

    const openSettings = useCallback((initial?: CodexSettings) => {
        const base = initial || {}
        setDraftPermissionMode(base.permissionMode || 'default')
        setDraftModel(base.model || '')
        setDraftProfile(base.profile || '')
        setDraftTextInput('')
        setEditingField(null)
        setSettingsSelection(0)
        setSettingsOpen(true)
    }, [])

    const closeSettings = useCallback(() => {
        setSettingsOpen(false)
        setEditingField(null)
        setDraftTextInput('')
    }, [])

    useEffect(() => {
        setMessages(messageBuffer.getMessages())
        
        const unsubscribe = messageBuffer.onUpdate((newMessages) => {
            setMessages(newMessages)
        })

        return () => {
            unsubscribe()
            if (confirmationTimeoutRef.current) {
                clearTimeout(confirmationTimeoutRef.current)
            }
        }
    }, [messageBuffer])

    useEffect(() => {
        if (settingsOpen) return
        setDraftPermissionMode(settings?.permissionMode || 'default')
        setDraftModel(settings?.model || '')
        setDraftProfile(settings?.profile || '')
    }, [settingsOpen, settings?.permissionMode, settings?.model, settings?.profile])

    const resetConfirmation = useCallback(() => {
        setConfirmationMode(false)
        if (confirmationTimeoutRef.current) {
            clearTimeout(confirmationTimeoutRef.current)
            confirmationTimeoutRef.current = null
        }
    }, [])

    const setConfirmationWithTimeout = useCallback(() => {
        setConfirmationMode(true)
        if (confirmationTimeoutRef.current) {
            clearTimeout(confirmationTimeoutRef.current)
        }
        confirmationTimeoutRef.current = setTimeout(() => {
            resetConfirmation()
        }, 15000) // 15 seconds timeout
    }, [resetConfirmation])

    const cyclePermissionMode = useCallback(() => {
        const index = permissionModeOptions.findIndex(opt => opt.value === draftPermissionMode)
        const next = permissionModeOptions[(index + 1) % permissionModeOptions.length]
        setDraftPermissionMode(next.value)
    }, [draftPermissionMode, permissionModeOptions])

    const normalizeSettings = useCallback((): CodexSettings => ({
        permissionMode: draftPermissionMode,
        model: draftModel.trim() ? draftModel.trim() : undefined,
        profile: draftProfile.trim() ? draftProfile.trim() : undefined,
    }), [draftPermissionMode, draftModel, draftProfile])

    useInput(useCallback(async (input, key) => {
        // Don't process input if action is in progress
        if (actionInProgress) return
        
        // Handle Ctrl-C - exits the agent directly instead of switching modes
        if (key.ctrl && input === 'c') {
            if (confirmationMode) {
                // Second Ctrl-C, exit
                resetConfirmation()
                setActionInProgress(true)
                // Small delay to show the status message
                await new Promise(resolve => setTimeout(resolve, 100))
                onExit?.()
            } else {
                // First Ctrl-C, show confirmation
                setConfirmationWithTimeout()
            }
            return
        }

        // Settings toggle / handler
        if (settingsOpen) {
            // Editing text field
            if (editingField) {
                if (key.escape) {
                    setEditingField(null)
                    setDraftTextInput('')
                    return
                }
                if (key.return) {
                    const value = draftTextInput
                    if (editingField === 'model') {
                        setDraftModel(value)
                    } else if (editingField === 'profile') {
                        setDraftProfile(value)
                    }
                    setEditingField(null)
                    setDraftTextInput('')
                    return
                }
                if (key.backspace || key.delete) {
                    setDraftTextInput(prev => prev.slice(0, -1))
                    return
                }
                if (typeof input === 'string' && input.length > 0 && !key.ctrl && !key.meta) {
                    setDraftTextInput(prev => prev + input)
                }
                return
            }

            // Non-editing settings navigation
            if (key.escape || input === 's') {
                closeSettings()
                return
            }
            if (key.upArrow) {
                setSettingsSelection(prev => (prev - 1 + settingsItems.length) % settingsItems.length)
                return
            }
            if (key.downArrow) {
                setSettingsSelection(prev => (prev + 1) % settingsItems.length)
                return
            }

            // Quick-select permission modes with number keys
            if (['1', '2', '3', '4'].includes(input)) {
                const idx = parseInt(input, 10) - 1
                if (permissionModeOptions[idx]) {
                    setDraftPermissionMode(permissionModeOptions[idx].value)
                }
                return
            }

            if (key.return) {
                const selected = settingsItems[settingsSelection]?.key
                if (selected === 'permissionMode') {
                    cyclePermissionMode()
                    return
                }
                if (selected === 'model') {
                    setEditingField('model')
                    setDraftTextInput(draftModel)
                    return
                }
                if (selected === 'profile') {
                    setEditingField('profile')
                    setDraftTextInput(draftProfile)
                    return
                }
                if (selected === 'cancel') {
                    closeSettings()
                    return
                }
                if (selected === 'save') {
                    const next = normalizeSettings()
                    if (!onUpdateSettings) {
                        closeSettings()
                        return
                    }
                    setActionInProgress(true)
                    setActionLabel('Saving settings...')
                    try {
                        await onUpdateSettings(next)
                        messageBuffer.addMessage('Saved Codex settings.', 'system')
                        closeSettings()
                    } catch (error) {
                        messageBuffer.addMessage(
                            `Failed to save settings: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            'system'
                        )
                    } finally {
                        setActionInProgress(false)
                        setActionLabel(null)
                    }
                    return
                }
            }

            return
        }

        if (input === 's') {
            openSettings(settings)
            return
        }

        // Any other key cancels confirmation
        if (confirmationMode) {
            resetConfirmation()
        }
    }, [
        actionInProgress,
        actionLabel,
        closeSettings,
        confirmationMode,
        cyclePermissionMode,
        draftModel,
        draftProfile,
        draftTextInput,
        editingField,
        messageBuffer,
        normalizeSettings,
        onExit,
        onUpdateSettings,
        openSettings,
        permissionModeOptions,
        resetConfirmation,
        setConfirmationWithTimeout,
        settings,
        settingsItems,
        settingsOpen,
        settingsSelection,
    ]))

    const getMessageColor = (type: BufferedMessage['type']): string => {
        switch (type) {
            case 'user': return 'magenta'
            case 'assistant': return 'cyan'
            case 'system': return 'blue'
            case 'tool': return 'yellow'
            case 'result': return 'green'
            case 'status': return 'gray'
            default: return 'white'
        }
    }

    const formatMessage = (msg: BufferedMessage): string => {
        const lines = msg.content.split('\n')
        const maxLineLength = terminalWidth - 10 // Account for borders and padding
        return lines.map(line => {
            if (line.length <= maxLineLength) return line
            const chunks: string[] = []
            for (let i = 0; i < line.length; i += maxLineLength) {
                chunks.push(line.slice(i, i + maxLineLength))
            }
            return chunks.join('\n')
        }).join('\n')
    }

    const currentSelectedPermissionMode = permissionModeOptions.find(opt => opt.value === draftPermissionMode)

    const renderSettings = () => {
        const selectedKey = settingsItems[settingsSelection]?.key

        const valueFor = (key: typeof settingsItems[number]['key']): string => {
            if (key === 'permissionMode') return draftPermissionMode
            if (key === 'model') return draftModel.trim() ? draftModel : '(default)'
            if (key === 'profile') return draftProfile.trim() ? draftProfile : '(default)'
            return ''
        }

        const helpText = (() => {
            if (editingField === 'model') return 'Editing model: Enter to save • Esc to cancel'
            if (editingField === 'profile') return 'Editing profile: Enter to save • Esc to cancel'
            if (selectedKey === 'permissionMode') return currentSelectedPermissionMode?.description || ''
            if (selectedKey === 'model') return 'Leave empty to use Codex default model (from config/profile).'
            if (selectedKey === 'profile') return 'Leave empty to use Codex default profile.'
            if (selectedKey === 'save') return 'Applies these defaults for new turns/sessions.'
            return 'Esc or s to close without saving.'
        })()

        return (
            <Box flexDirection="column">
                <Box flexDirection="column" marginBottom={1}>
                    <Text bold color="cyan">Settings</Text>
                    <Text color="gray" dimColor>↑/↓ to navigate • Enter to edit • Esc to close</Text>
                </Box>

                <Box flexDirection="column" marginBottom={1}>
                    {settingsItems.map((item, idx) => {
                        const selected = idx === settingsSelection
                        const prefix = selected ? '› ' : '  '

                        const isEditingThis =
                            (item.key === 'model' && editingField === 'model') ||
                            (item.key === 'profile' && editingField === 'profile')

                        const value = isEditingThis ? `${draftTextInput}_` : valueFor(item.key)
                        const line = item.key === 'save' || item.key === 'cancel'
                            ? `${prefix}${item.label}`
                            : `${prefix}${item.label}: ${value}`

                        return (
                            <Text key={item.key} color={selected ? 'yellow' : 'white'} bold={selected}>
                                {line}
                            </Text>
                        )
                    })}
                </Box>

                {helpText ? (
                    <Box flexDirection="column">
                        <Text color="gray" dimColor>{'─'.repeat(Math.min(terminalWidth - 4, 60))}</Text>
                        <Text color="gray" dimColor>{helpText}</Text>
                        {selectedKey === 'permissionMode' && draftPermissionMode === 'yolo' ? (
                            <Text color="red" bold>
                                Warning: yolo disables sandboxing and approvals.
                            </Text>
                        ) : null}
                        {selectedKey === 'permissionMode' ? (
                            <Text color="gray" dimColor>Tip: press 1–4 to pick a mode quickly.</Text>
                        ) : null}
                    </Box>
                ) : null}
            </Box>
        )
    }

    return (
        <Box flexDirection="column" width={terminalWidth} height={terminalHeight}>
            {/* Main content area with logs */}
            <Box 
                flexDirection="column" 
                width={terminalWidth}
                height={terminalHeight - 4}
                borderStyle="round"
                borderColor="gray"
                paddingX={1}
                overflow="hidden"
            >
                <Box flexDirection="column" marginBottom={1}>
                    <Text color="gray" bold>🤖 Codex Agent Messages</Text>
                    <Text color="gray" dimColor>{'─'.repeat(Math.min(terminalWidth - 4, 60))}</Text>
                </Box>
                
                <Box flexDirection="column" height={terminalHeight - 10} overflow="hidden">
                    {settingsOpen ? (
                        renderSettings()
                    ) : messages.length === 0 ? (
                        <Text color="gray" dimColor>Waiting for messages...</Text>
                    ) : (
                        // Show only the last messages that fit in the available space
                        messages.slice(-Math.max(1, terminalHeight - 10)).map((msg) => (
                            <Box key={msg.id} flexDirection="column" marginBottom={1}>
                                <Text color={getMessageColor(msg.type)} dimColor>
                                    {formatMessage(msg)}
                                </Text>
                            </Box>
                        ))
                    )}
                </Box>
            </Box>

            {/* Modal overlay at the bottom */}
            <Box 
                width={terminalWidth}
                borderStyle="round"
                borderColor={
                    actionInProgress ? "gray" :
                    confirmationMode ? "red" : 
                    "green"
                }
                paddingX={2}
                justifyContent="center"
                alignItems="center"
                flexDirection="column"
            >
                <Box flexDirection="column" alignItems="center">
                    {actionInProgress ? (
                        <Text color="gray" bold>
                            {actionLabel || 'Working...'}
                        </Text>
                    ) : settingsOpen ? (
                        <Text color="yellow" bold>
                            Settings • Enter to select • Esc to close
                        </Text>
                    ) : confirmationMode ? (
                        <Text color="red" bold>
                            ⚠️  Press Ctrl-C again to exit the agent
                        </Text>
                    ) : (
                        <>
                            <Text color="green" bold>
                                🤖 Codex Agent Running • s Settings • Ctrl-C to exit
                            </Text>
                        </>
                    )}
                    {process.env.DEBUG && logPath && (
                        <Text color="gray" dimColor>
                            Debug logs: {logPath}
                        </Text>
                    )}
                </Box>
            </Box>
        </Box>
    )
}
