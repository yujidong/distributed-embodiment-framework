/**
 * ErrorBoundary — class component (hooks can't catch render errors). Catches
 * render/lifecycle errors below it and shows a friendly fallback instead of
 * unmounting the whole app: 刷新页面 reloads, 回工作台 navigates home and
 * resets the boundary. Mounted at the route root in App, plus locally around
 * the world view and the simulation console so one crashing panel does not
 * take down the entire page.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

import i18n from '../i18n/config';
import { navigateTo } from '../lib/navigation';
import { Button } from './ui/Button';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Fallback heading, e.g. the name of the failing section. */
  title?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private backToWorkbench = () => {
    this.setState({ error: null });
    navigateTo('/');
  };

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div className="error-boundary" role="alert">
          <h2 className="error-boundary__title">{this.props.title ?? i18n.t('errorBoundary:defaultTitle')}</h2>
          <p className="page-note">
            {i18n.t('errorBoundary:body', { message: error.message })}
          </p>
          <div className="error-boundary__actions">
            <Button variant="primary" onClick={() => window.location.reload()}>
              {i18n.t('errorBoundary:reload')}
            </Button>
            <Button onClick={this.backToWorkbench}>{i18n.t('errorBoundary:backToWorkbench')}</Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
