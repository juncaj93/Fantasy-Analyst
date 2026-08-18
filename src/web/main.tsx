import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { restoreDemo } from './demo/session.ts';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root element is missing');

const render = () =>
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

/*
 * Demo Mode is restored before the first render, not after it.
 *
 * A scenario chosen earlier — or named in the URL, which is how the audit
 * selects one — has to be in force before the app makes its first request. Do
 * this afterwards and the shell fetches the live overview, paints a live
 * league, and then swaps it for a demo, which is a flash of somebody else's
 * data on a screen about to claim to be a demo.
 *
 * `restoreDemo` never rejects: an unknown or unwired scenario id falls back to
 * live mode. A dynamic import means none of the demo's fixtures are fetched for
 * the overwhelmingly common case of no demo being requested at all.
 */
void restoreDemo().finally(render);
