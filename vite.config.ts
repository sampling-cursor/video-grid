import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1]
const isGitHubActions = Boolean(process.env.GITHUB_ACTIONS)

// https://vite.dev/config/
export default defineConfig({
  base: isGitHubActions && repositoryName ? `/${repositoryName}/` : '/',
  plugins: [react()],
})
