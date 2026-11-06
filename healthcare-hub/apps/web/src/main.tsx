import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { createApiClient } from './api.js';
import { createAuthClient } from './auth.js';
import { BRAND } from './brand.js';
import './index.css';

document.title = BRAND.name;

const auth = createAuthClient();
const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <App api={createApiClient(auth)} auth={auth} />
  </StrictMode>,
);
