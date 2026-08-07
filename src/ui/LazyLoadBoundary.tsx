import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from 'react'

interface LazyLoadBoundaryProps {
  children: ReactNode
  fallback: ReactNode
  resetKey?: unknown
}

interface LazyLoadBoundaryState {
  failed: boolean
  resetKey: unknown
}

/** Catch a rejected React.lazy import without replacing the whole product. */
export default class LazyLoadBoundary extends Component<
  LazyLoadBoundaryProps,
  LazyLoadBoundaryState
> {
  state: LazyLoadBoundaryState = {
    failed: false,
    resetKey: this.props.resetKey,
  }

  static getDerivedStateFromError(): Partial<LazyLoadBoundaryState> {
    return { failed: true }
  }

  static getDerivedStateFromProps(
    props: LazyLoadBoundaryProps,
    state: LazyLoadBoundaryState,
  ): Partial<LazyLoadBoundaryState> | null {
    return props.resetKey === state.resetKey
      ? null
      : { failed: false, resetKey: props.resetKey }
  }

  componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // The visible fallback owns recovery. Do not log project or file data.
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
