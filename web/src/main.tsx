import { render } from 'preact';
import { App } from './app';
import { PreferencesProvider } from './preferences';
import { registerServiceWorker } from './sw';
import './styles.css';

const root = document.getElementById('app');
if (!root) throw new Error('App root not found');
if (import.meta.env.MODE === 'demo') {
  void import('./demo').then(({Demo})=>render(<PreferencesProvider><Demo /></PreferencesProvider>,root));
} else {
  render(<PreferencesProvider><App /></PreferencesProvider>,root);
  void registerServiceWorker();
}
