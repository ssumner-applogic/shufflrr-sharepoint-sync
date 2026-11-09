import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClerkProvider, SignIn, SignUp, useAuth, useClerk } from '@clerk/react';
import { shadcn } from '@clerk/ui/themes';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Home from '@/pages/home';
import {
  Redirect,
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

const queryClient = new QueryClient();
const appName = 'Shufflrr-SharePoint Sync Agent';
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const signInPath = `${basePath}/sign-in`;
const signUpPath = `${basePath}/sign-up`;

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: 'hsl(182 95% 26%)',
    colorForeground: 'hsl(188 30% 13%)',
    colorMutedForeground: 'hsl(180 5% 40%)',
    colorDanger: 'hsl(0 68% 48%)',
    colorBackground: 'hsl(40 30% 99%)',
    colorInput: 'hsl(40 30% 99%)',
    colorInputForeground: 'hsl(188 30% 13%)',
    colorNeutral: 'hsl(188 30% 13%)',
    fontFamily: 'IBM Plex Sans, sans-serif',
    borderRadius: '0.5rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-card rounded-xl w-[440px] max-w-full overflow-hidden',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-foreground',
    headerSubtitle: 'text-muted-foreground',
    formFieldLabel: 'text-foreground',
    formFieldInput: 'border-input bg-background text-foreground',
    formButtonPrimary: 'bg-primary text-primary-foreground hover:bg-primary/90',
    footerActionText: 'text-muted-foreground',
    footerActionLink: 'text-primary hover:text-primary/90',
    dividerText: 'text-muted-foreground',
    alertText: 'text-destructive',
  },
};

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function LoadingScreen() {
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-background" role="status">
      <span className="text-sm text-muted-foreground">Loading…</span>
    </main>
  );
}

function PublicLanding() {
  const [, setLocation] = useLocation();
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-background px-4 py-8">
      <section className="w-full max-w-md rounded-xl border bg-card p-7 text-center shadow-sm">
        <img src={`${basePath}/logo.svg`} alt="" className="mx-auto size-12" />
        <h1 className="mt-4 text-xl font-semibold tracking-tight">{appName}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Sign in to continue.</p>
        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setLocation('/sign-in')}
            className="rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Sign in
          </button>
          <button
            type="button"
            onClick={() => setLocation('/sign-up')}
            className="rounded-md border px-4 py-2.5 text-sm font-medium hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Create an account
          </button>
        </div>
      </section>
    </main>
  );
}

function SignInPage() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <LoadingScreen />;
  if (isSignedIn) return <Redirect to={basePath || '/'} />;
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-background px-4 py-8">
      <SignIn
        routing="path"
        path={signInPath}
        signUpUrl={signUpPath}
        fallbackRedirectUrl={basePath || '/'}
        appearance={clerkAppearance}
      />
    </main>
  );
}

function SignUpPage() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <LoadingScreen />;
  if (isSignedIn) return <Redirect to={basePath || '/'} />;
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-background px-4 py-8">
      <SignUp
        routing="path"
        path={signUpPath}
        signInUrl={signInPath}
        fallbackRedirectUrl={basePath || '/'}
        appearance={clerkAppearance}
      />
    </main>
  );
}

function ProtectedHome() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <LoadingScreen />;
  if (!isSignedIn) return <PublicLanding />;
  return <Home />;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const previousUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (previousUserId.current !== undefined && previousUserId.current !== userId) {
        queryClient.clear();
      }
      previousUserId.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  return null;
}

function ClerkRoutes({ publishableKey }: { publishableKey: string }) {
  const [, setLocation] = useLocation();

  const stripBase = (path: string) =>
    basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      signInUrl={signInPath}
      signUpUrl={signUpPath}
      appearance={clerkAppearance}
      routerPush={to => setLocation(stripBase(to))}
      routerReplace={to => setLocation(stripBase(to), { replace: true })}
    >
      <ClerkQueryClientCacheInvalidator />
      <RoutedErrorBoundary>
        <Switch>
          <Route path="/sign-in/*?" component={SignInPage} />
          <Route path="/sign-up/*?" component={SignUpPage} />
          <Route path="/" component={ProtectedHome} />
          <Route component={NotFound} />
        </Switch>
      </RoutedErrorBoundary>
    </ClerkProvider>
  );
}

function App({ publishableKey }: { publishableKey: string }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={basePath}>
          <ClerkRoutes publishableKey={publishableKey} />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
