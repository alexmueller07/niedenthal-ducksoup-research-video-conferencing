import { NextConfig } from 'next'
import path from 'path'
import { fileURLToPath } from 'url'

const rendererDir = path.dirname(fileURLToPath(import.meta.url))
// The app root (where package.json / package-lock.json live) is the parent of
// renderer/. Pinning this stops Turbopack from inferring C:\Users\amuel as the
// workspace root (it would otherwise watch the entire home directory).
const appRoot = path.join(rendererDir, '..')

const config: NextConfig = {
  output: 'export',
  distDir: process.env.NODE_ENV === 'production' ? '../app' : '.next',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  turbopack: {
    root: appRoot,
  },
}

export default config
