import Link from 'next/link'
import Head from 'next/head'
import { useRouter } from 'next/router'
import type { ReactNode } from 'react'
import {
  ArrowUpRight,
  Video,
  ClipboardList,
  FolderOpen,
  FlaskConical,
  Settings,
  LayoutGrid,
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
      <aside className="suite-sidebar">
        <Link href="/" className="suite-brand">
          <span className="suite-brand-mark">
            <Video size={21} />
          </span>
          <span>
            Session View<small>Research suite</small>
          </span>
        </Link>
        <nav aria-label="Suite navigation">
          <Link
            href="/"
            className={`suite-nav ${pathname === '/' ? 'selected' : ''}`}
            aria-current={pathname === '/' ? 'page' : undefined}
          >
            <LayoutGrid size={18} />
            Overview
          </Link>
          <span className="suite-nav-label">Workspace</span>
          {SUITE_SECTIONS.map((s) => (
            <Link
              href={s.href}
              key={s.href}
              className={`suite-nav ${current?.href === s.href ? 'selected' : ''}`}
              aria-current={current?.href === s.href ? 'page' : undefined}
            >
              <s.icon size={18} />
              <span>{s.title}</span>
              {s.badge && <small>Preview</small>}
            </Link>
          ))}
        </nav>
        <footer>
          <span className="suite-status-dot" />
          Local workspace<span>v{APP_VERSION}</span>
        </footer>
      </aside>
      <div className="suite-main">
        <header className="suite-topbar">
          <span>
            Workspace <span className="suite-muted">/</span>{' '}
            <strong>{current?.title || 'Overview'}</strong>
          </span>
          <Link
            href="/settings"
            title="Settings and updates"
            aria-label="Settings and updates"
          >
            <Settings size={18} />
          </Link>
        </header>
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
