import { Component, type ErrorInfo, type ReactNode } from 'react'

interface AppErrorBoundaryProps {
  children: ReactNode
}

interface AppErrorBoundaryState {
  failed: boolean
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(JSON.stringify({
      event: 'client_render_failed',
      errorType: error.name,
      componentStackPresent: Boolean(info.componentStack),
    }))
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="fatal-error" role="alert">
        <div className="brand-mark" aria-hidden="true">SG</div>
        <h1>The application cannot continue</h1>
        <p>The encrypted session has stopped. To protect room credentials, error details are not uploaded.</p>
        <button className="primary-button" type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </main>
    )
  }
}
