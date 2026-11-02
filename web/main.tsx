import '@fontsource-variable/jost'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

// Tokens follow the system on their own; this keeps Tailwind's `dark:` variant in step.
const dark = window.matchMedia('(prefers-color-scheme: dark)')
const applyScheme = () => document.documentElement.classList.toggle('dark', dark.matches)
applyScheme()
dark.addEventListener('change', applyScheme)

createRoot(document.getElementById('root')!).render(<App />)
