import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/roboto/latin-400.css';
import '@fontsource/roboto/latin-500.css';
import '@fontsource/roboto/latin-700.css';
import './styles.css';
import App from './App';
import PlayerOverlay from './PlayerOverlay';
const overlay = new URLSearchParams(location.search).get('player-overlay') === '1';
if (overlay) { document.documentElement.dataset.playerOverlay = 'true'; document.documentElement.dataset.theme = 'dark'; }

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{overlay ? <PlayerOverlay /> : <App />}</React.StrictMode>);
