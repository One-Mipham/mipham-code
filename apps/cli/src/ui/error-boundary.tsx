/**
 * Fix 8: Error Boundary for UI Rendering Protection
 *
 * Catches rendering errors in the React/Ink component tree,
 * preventing the "layout freeze" bug where the interactive session
 * stops redrawing while the process stays alive.
 *
 * Recovery path: renders a fallback message with a hint that the
 * user can press Enter to attempt recovery (re-render).
 */

import React, { Component } from 'react'
import { Text, Box } from 'ink'
import { useI18n } from '../i18n-context'

interface Props {
  children: React.ReactNode
  /** Called when a render error is caught */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
}

interface State {
  hasError: boolean
  error: Error | null
  errorCount: number
}

export class ErrorBoundary extends Component<Props, State> {
  private resetTimer: ReturnType<typeof setTimeout> | null = null

  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, errorCount: 0 }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Log to stderr for diagnostics
    process.stderr.write(
      `\n⚠️  UI Error Boundary caught: ${error.message}\n` +
        `   Component: ${errorInfo.componentStack?.slice(0, 200) || 'unknown'}\n`,
    )

    this.props.onError?.(error, errorInfo)

    // Auto-recovery: reset after 5 seconds to attempt re-render
    this.resetTimer = setTimeout(() => {
      this.setState((prev) => ({
        hasError: false,
        error: null,
        errorCount: prev.errorCount,
      }))
    }, 5_000)
  }

  override componentWillUnmount(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer)
    }
  }

  override render(): React.ReactNode {
    if (this.state.hasError) {
      return <ErrorFallback error={this.state.error} />
    }

    return this.props.children
  }
}

function ErrorFallback({ error }: { error: Error | null }): React.ReactNode {
  const { t } = useI18n()
  return (
    <Box flexDirection="column" padding={1}>
      <Text color="red" bold>
        {t('ui.error_boundary.title')}
      </Text>
      <Text dimColor>{error?.message || t('ui.error_boundary.unknown')}</Text>
      <Text> </Text>
      <Text dimColor>{t('ui.error_boundary.recovery')}</Text>
      <Text> </Text>
      <Text color="yellow">{t('ui.error_boundary.preserved')}</Text>
    </Box>
  )
}
