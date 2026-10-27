import React from 'react'

interface Props {
  children: React.ReactNode
}
interface State {
  error: Error | null
}

/**
 * Catches render-phase crashes (e.g. a malformed document that slipped past
 * `parseDocument` and throws inside a projection/exporter) so the app shows a
 * recoverable message instead of unmounting to a blank white screen.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Surface for diagnostics; the renderer console is the only sink here.
    console.error('Renderer crashed:', error, info.componentStack)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'sans-serif', color: '#222' }}>
          <h2 style={{ color: '#c62828' }}>Something went wrong</h2>
          <p>
            The editor hit an unexpected error — most likely a malformed harness file. Your last
            saved file on disk is untouched.
          </p>
          <pre
            style={{
              background: '#f5f5f5',
              padding: 12,
              borderRadius: 4,
              overflow: 'auto',
              maxHeight: 200
            }}
          >
            {this.state.error.message}
          </pre>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      )
    }
    return this.props.children
  }
}
