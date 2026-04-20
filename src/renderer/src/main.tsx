import './lib/monacoSetup'; // must be first — configures Monaco workers before any editor renders
import './i18n'; // initialise i18next before rendering
import ReactDOM from 'react-dom/client';
import App from './App';

// StrictMode is intentionally omitted: it causes useEffect to run twice,
// which registers duplicate IPC listeners and leads to doubled streaming text.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
