import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Banner } from './Banner.js'
import { Button } from './primitives.js'

// Without this, a single render-time throw anywhere in the tree blanks
// the whole panel: React unmounts the root and there is nothing left to
// show the user — not even the nav to get somewhere else.
//
// Two are mounted: one around the routes (catches the chrome itself) and
// one around the page inside the chrome, keyed on the path so navigating
// away clears the error and leaves the nav usable meanwhile.

interface Props {
  children: ReactNode
  /** Shown above the message, e.g. "This page". */
  what?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('render error', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="cmd-wide space-y-4 p-4">
        <Banner
          tone="bad"
          actions={
            <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
              Reload
            </Button>
          }
        >
          {this.props.what ?? 'Something'} hit an unexpected error: {error.message}
        </Banner>
      </div>
    )
  }
}
