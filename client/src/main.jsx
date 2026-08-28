import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './lib/auth';
import { ToastProvider } from './components/ui';
import { BrandingProvider } from './lib/branding';
import { TemaProvider } from './lib/tema';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <TemaProvider>
      <ToastProvider>
        <BrandingProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
        </BrandingProvider>
      </ToastProvider>
      </TemaProvider>
    </BrowserRouter>
  </React.StrictMode>
);
