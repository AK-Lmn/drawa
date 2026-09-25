import { defineConfig } from 'vite'
import { spawn } from 'node:child_process'

// The Python server owns the API and runs Claude; Vite only serves the UI in dev.
const api = { target: 'http://127.0.0.1:8765', changeOrigin: true }

export default defineConfig({
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 }, // big chunks are Mermaid's, loaded only when a diagram appears
  server: { port: 5173, strictPort: true, proxy: { '/api': api, '/ask': api } },
  plugins: [{
    name: 'python-server',
    apply: 'serve',
    // `npm run dev` also starts server.py (it restarts itself when edited). Project folder: CLAUDE_UI_ROOT, default the repo.
    configureServer() {
      const py = spawn('python3', ['../server.py', process.env.CLAUDE_UI_ROOT ?? '..'], { stdio: 'inherit' })
      process.on('exit', () => py.kill())
    },
  }],
})
