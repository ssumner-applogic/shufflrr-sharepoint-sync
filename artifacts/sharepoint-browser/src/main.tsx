import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';

import './index.css';

function BootstrapScreen({ error, onRetry }: { error?: boolean; onRetry?: () => void }) {
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-background px-4">
      <div className="text-center" role={error ? 'alert' : 'status'}>
        <p className="text-sm text-muted-foreground">
          {error ? 'Authentication could not be loaded.' : 'Loading…'}
        </p>
        {error && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Retry
          </button>
        )}
      </div>
    </main>
  );
}

function isAuthConfig(value: unknown): value is { publishableKey: string } {
  if (!value || typeof value !== 'object' || !('publishableKey' in value)) return false;
  return typeof value.publishableKey === 'string' && value.publishableKey.startsWith('pk_');
}

function AppBootstrap() {
  const [publishableKey, setPublishableKey] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void fetch('/api/auth/config', { credentials: 'same-origin', cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('Configuration request failed.');
        const payload: unknown = await response.json();
        if (!isAuthConfig(payload)) throw new Error('Invalid authentication configuration.');
        if (!cancelled) setPublishableKey(payload.publishableKey);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (failed) return <BootstrapScreen error onRetry={() => setAttempt(value => value + 1)} />;
  if (!publishableKey) return <BootstrapScreen />;
  return <App publishableKey={publishableKey} />;
}

createRoot(document.getElementById('root')!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <AppBootstrap />
  </ErrorBoundary>,
);
