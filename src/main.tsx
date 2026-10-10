import React from 'react'
import { createRoot } from 'react-dom/client'
import { getCurrentWindow } from '@tauri-apps/api/window'
import App from './App'
import { IslandApp } from './island/IslandApp'
import './styles/theme.css'
import './styles/layout.css'
import './styles/island.css'

// The floating island loads the same page in its own window.
const island = '__TAURI_INTERNALS__' in window && getCurrentWindow().label === 'island'
if (island) { document.documentElement.classList.add('island-host'); document.documentElement.dataset.theme = 'dark' }

createRoot(document.getElementById('root')!).render(<React.StrictMode>{island ? <IslandApp/> : <App/>}</React.StrictMode>)
