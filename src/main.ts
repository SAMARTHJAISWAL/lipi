import '@fontsource/instrument-serif/latin-400.css';
import '@fontsource/instrument-serif/latin-400-italic.css';
import '@fontsource-variable/instrument-sans/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource/tiro-devanagari-hindi/devanagari-400.css';
import './style.css';
import { App } from './ui/app';

const app = new App();

declare global {
  interface Window {
    __lipi: unknown;
  }
}
window.__lipi = { app };
