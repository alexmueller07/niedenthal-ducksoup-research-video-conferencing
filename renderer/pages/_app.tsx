import type { AppProps } from 'next/app'
import { useRouter } from 'next/router'
import { SuiteShell } from '../components/SuiteShell'
import { SessionArchiveProvider } from '../components/SessionArchiveProvider'

import '../styles/globals.css'
import '../styles/suite.css'

function MyApp({ Component, pageProps }: AppProps) {
  const { pathname } = useRouter()
  const page = <Component {...pageProps} />
  return (
    <SessionArchiveProvider>
      {['/', '/call', '/rating', '/data', '/testing', '/settings'].includes(
        pathname,
      ) ? (
        <SuiteShell>{page}</SuiteShell>
      ) : (
        page
      )}
    </SessionArchiveProvider>
  )
}

export default MyApp
