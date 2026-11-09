/// <reference types="vite/client" />
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import { App } from './app';

const container = document.getElementById('root');
if (!container) throw new Error('index.html has no #root element to mount the app in');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
