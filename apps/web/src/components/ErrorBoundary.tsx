import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

/**
 * Catches render errors in its subtree and renders a visible fallback instead
 * of propagating the error up the component tree.
 *
 * The fallback prop overrides the default message. When no fallback is supplied,
 * a styled diagnostic shows "⚠ render error — see console" with the first 120
 * characters of the error message — never silent null.
 *
 * Used to isolate the SolarMesh and Inspector panels so a malformed event
 * payload never blanks the entire page.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(err: unknown): State {
    return { hasError: true, message: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: unknown): void {
    console.warn('[ErrorBoundary] caught render error:', err);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-secondary)',
            padding: 16,
            opacity: 0.6,
          }}
        >
          ⚠ render error — see console
          <br />
          <span style={{ opacity: 0.5 }}>{this.state.message.slice(0, 120)}</span>
        </div>
      );
    }
    return this.props.children;
  }
}
