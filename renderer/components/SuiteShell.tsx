import Link from 'next/link'
import Head from 'next/head'
import { useRouter } from 'next/router'
import type { ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  Video,
  ClipboardList,
  FolderOpen,
  FlaskConical,
  Settings,
} from 'lucide-react'
import { APP_VERSION } from '../lib/protocol'

export const SUITE_SECTIONS = [
  {
    href: '/call',
    title: 'Video Calling',
    detail: 'Participant sessions and researcher controls',
    icon: Video,
    tone: 'cyan',
  },
  {
    href: '/rating',
    title: 'Rating Station',
    detail: 'Recorded conversations and participant review',
    icon: ClipboardList,
    tone: 'violet',
    badge: undefined,
    // Not used for the current study; the page still works if you go to /rating.
    hidden: true,
  },
  {
    href: '/data',
    title: 'Session Data',
    detail: 'Recordings, measurements, and responses',
    icon: FolderOpen,
    tone: 'green',
  },
  {
    href: '/testing',
    title: 'Testing Station',
    detail: 'Face, voice, and calibration checks',
    icon: FlaskConical,
    tone: 'amber',
  },
  {
    href: '/settings',
    title: 'Settings & Updates',
    detail: 'Devices, study defaults, and storage',
    icon: Settings,
    tone: 'gray',
  },
]

export function SuiteShell({ children }: { children: ReactNode }) {
  const { pathname } = useRouter()
  const current = SUITE_SECTIONS.find(
    (s) =>
      s.href === pathname ||
      (pathname === '/dashboard' && s.href === '/testing'),
  )
  return (
    <div className="suite">
      <Head>
        <title>
          {current ? `${current.title} | Session View` : 'Session View'}
        </title>
      </Head>
      <div className="suite-main">
        {/* The Testing Station has its own header with a safe Back button (it stops a running test first). */}
        {pathname !== '/testing' && <header className="suite-topbar">
          {pathname === '/' ? (
            <span className="suite-topbar-brand">
              <span className="suite-brand-mark">
                <Video size={18} />
              </span>
              <strong>Session View</strong>
              <span className="suite-muted">Research suite</span>
            </span>
          ) : (
            <span className="suite-topbar-back">
              <Link href="/" className="suite-btn" aria-label="Back to the dashboard">
                <ArrowLeft size={16} />
                Dashboard
              </Link>
              <strong>{current?.title}</strong>
            </span>
          )}
          <span className="suite-muted">v{APP_VERSION}</span>
        </header>}
        {children}
      </div>
    </div>
  )
}

export function PageHeading({
  title,
  eyebrow,
  children,
  action,
}: {
  title: string
  eyebrow?: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="suite-heading">
      <div>
        {eyebrow && <p className="suite-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {children && <div className="suite-muted">{children}</div>}
      </div>
      {action}
    </div>
  )
}

export function OpenArrow() {
  return <ArrowUpRight size={18} aria-hidden="true" />
}
