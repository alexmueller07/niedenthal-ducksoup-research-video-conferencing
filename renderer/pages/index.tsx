import Link from 'next/link'
import { ArrowRight, Video, ClipboardList, FolderOpen } from 'lucide-react'
import {
  PageHeading,
  SUITE_SECTIONS,
  OpenArrow,
} from '../components/SuiteShell'

export default function SuiteHome() {
  return (
    <main className="suite-content">
      <PageHeading eyebrow="Session View" title="Research workspace">
        <p>Choose a station to begin.</p>
      </PageHeading>
      <div className="suite-launchers">
        {SUITE_SECTIONS.map((s, i) => (
          <Link
            className={`suite-launcher tone-${s.tone}`}
            href={s.href}
            key={s.href}
          >
            <div className="suite-launcher-top">
              <span className="suite-mode-icon">
                <s.icon size={24} />
              </span>
              <OpenArrow />
            </div>
            <div>
              <span className="suite-eyebrow">
                0{i + 1}
                {s.badge ? ' / Preview' : ''}
              </span>
              <h2>{s.title}</h2>
              <p>{s.detail}</p>
            </div>
            <span className="suite-open">
              Open station <ArrowRight size={16} />
            </span>
          </Link>
        ))}
      </div>
      <section className="suite-workflow">
        <h2>Session workflow</h2>
        <div>
          <span>
            <Video size={18} />
            Run a conversation
          </span>
          <ArrowRight size={16} />
          <span>
            <ClipboardList size={18} />
            Review & rate
          </span>
          <ArrowRight size={16} />
          <span>
            <FolderOpen size={18} />
            Explore session data
          </span>
        </div>
      </section>
    </main>
  )
}
