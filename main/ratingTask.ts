// Source: niedenthal-research-lab-suite, PostConversation and DyadTaskMain.
// Keep item IDs, wording, order, and scales stable across presentation changes.
export const RATING_TASK_VERSION = 'continuous-dyad-1'
export const POST_CONVERSATION_ITEMS = [
  ['influence_partner', "To what extent do you feel YOU were influencing YOUR PARTNER'S emotions?"],
  ['influenced_by_partner', "To what extent do you feel YOUR PARTNER was influencing YOUR emotions?"],
  ['predict_partner', "To what extent do you feel you could predict YOUR PARTNER'S emotions?"],
  ['flow', 'How well did the conversation “flow”?'],
  ['enjoyment', 'How much did you enjoy the conversation you had with your study partner?'],
  ['fits_with_friends', 'Can you picture your study partner fitting in with your friends?'],
  ['friendship', 'How much would you like to be friends with your study partner?'],
  ['comfort', 'How comfortable did you feel during the conversation?'],
  ['self_focus', 'How much were you focused on yourself during the conversation?'],
  ['relative_talking', 'Think about how much you and your study partner each talked during your conversation, and indicate your relative contributions on the scale below:'],
] as const

export const RATING_INSTRUCTIONS = [
  "Before we begin: please check that the computer's volume is at a comfortable level. You will hear the audio from your conversation. Ask your researcher if you would like help adjusting it.",
  'In this part of the study, you will watch the video recording of the conversation you just had.',
  'We are interested in two things: how YOU were feeling during the conversation, and how YOUR PARTNER was feeling during the conversation.',
  'The video is split into parts. Before each part, the screen will tell you whether to focus on YOUR OWN feelings or YOUR PARTNER’S feelings, and a reminder stays on the screen while you watch.',
  'As the video plays, continuously move the slider to indicate how positive or negative YOU or YOUR PARTNER felt at that moment during the conversation.',
  'At certain points, you will be asked to write a short response and make ratings about how you or your partner felt during the part of the conversation you just watched.',
]

export function validQuestionnaire(value: unknown): value is Record<string, number | null> {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return POST_CONVERSATION_ITEMS.every(([id]) => id in v && (v[id] === null ||
    (typeof v[id] === 'number' && Number.isInteger(v[id]) &&
      (v[id] as number) >= (id === 'relative_talking' ? -5 : 0) &&
      (v[id] as number) <= (id === 'relative_talking' ? 5 : 10))))
}
