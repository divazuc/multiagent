import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const n8nBase = (env.VITE_N8N_URL || 'https://divazuc.app.n8n.cloud').replace(/\/$/, '')

  return {
    plugins: [react()],
    server: {
      port: 5174,
      proxy: {
        '/api/n8n': {
          target: n8nBase,
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/n8n/, '')
        },
        '/api/agent': {
          target: 'http://localhost:8080',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/agent/, '')
        }
      }
    }
  }
})
