import { useState } from 'react'
import { POST_CONVERSATION_ITEMS } from '../../main/ratingTask'
import PostConversation from './rating/PostConversation'
import type { PSlot, StudyFlowState } from '../lib/protocol'

// What a participant sees between conversation blocks, while the researcher
// steps through the study flow. The conversation itself is the normal call
// view, so this renders nothing for it.

const center = 'fixed inset-0 z-30 flex cursor-auto flex-col items-center justify-center bg-black px-12 text-center text-white'

export function StudyFlowScreen({ state, mySlot, send }: {
  state: StudyFlowState
  mySlot: PSlot
  send: (step: number, responses: Record<string, number | null>) => void
}) {
  const step = state.steps[state.step]
  if (!step || (state.status !== 'running' && state.status !== 'complete')) return null
  if (step.kind === 'conversation') return null
  if (step.kind === 'survey') return <div className={center}><h1 className="text-4xl">{step.label}</h1></div>
  if (step.kind === 'tiktok') return <div className={center}><h1 className="text-4xl">TikTok task</h1></div>
  if (step.kind === 'intro') return <div className={center}>
    <p className="mb-6 text-2xl text-gray-400">Block {step.block}</p>
    <h1 className="text-4xl">In this conversation, please talk about {step.valence} experiences.</h1>
  </div>
  return <RatingStep key={state.step} step={state.step} submitted={state.submitted[mySlot]} send={send} />
}

function RatingStep({ step, submitted, send }: {
  step: number
  submitted: boolean
  send: (step: number, responses: Record<string, number | null>) => void
}) {
  const [answers, setAnswers] = useState<Record<string, number>>({})
  const [sent, setSent] = useState(false)
  if (submitted || sent) return <div className={center}><p className="text-3xl">Thank you. Please wait.</p></div>
  return <div id="rating-root">
    <PostConversation
      title="Thinking back on the last five minutes of your conversation, please answer the following."
      responses={answers}
      onChange={(k, v) => setAnswers(a => ({ ...a, [k]: v }))}
      onContinue={() => {
        setSent(true)
        send(step, Object.fromEntries(POST_CONVERSATION_ITEMS.map(([id]) => [id, answers[id] ?? null])))
      }}
    />
  </div>
}
