import { defineConfig } from '@playwright/test'

export default defineConfig({
  testMatch: '**/*.e2e.ts',
  tsconfig: './tsconfig.playwright.json',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
})
