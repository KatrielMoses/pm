import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Routes } from './app-routes.tsx';
import { AuthProvider } from './auth.tsx';
import { Router } from './router.tsx';
import { CommandProvider } from './shell/commands.tsx';
import { PreferencesProvider } from './shell/preferences.tsx';
import { StepUpProvider } from './stepup.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router>
      <AuthProvider>
        <PreferencesProvider>
          <StepUpProvider>
            <CommandProvider>
              <Routes />
            </CommandProvider>
          </StepUpProvider>
        </PreferencesProvider>
      </AuthProvider>
    </Router>
  </StrictMode>,
);
