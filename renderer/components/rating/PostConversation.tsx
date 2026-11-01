import { useState } from "react";
import NumberScale from "./NumberScale";
import QuestionnairePage from "./QuestionnairePage";
import { POST_CONVERSATION_ITEMS } from "../../../main/ratingTask";

// The questionnaire that opens the rating task. The wording, order and scales
// are the lab suite's (and the paper instrument's): 0-10 from "Not at all" to
// "Very much", and the relative-talking item on its own -5 … +5 scale with a
// middle anchor. Item order is fixed, not shuffled.

const TALK_ITEM_KEY = "relative_talking";

export default function PostConversation({
  responses,
  onChange,
  onContinue,
}: {
  responses: Record<string, number>;
  onChange: (key: string, value: number) => void;
  onContinue: () => void;
}) {
  const [attempted, setAttempted] = useState(false);
  const labels = Object.fromEntries(POST_CONVERSATION_ITEMS) as Record<string, string>;
  const keys = POST_CONVERSATION_ITEMS.map(([id]) => id as string);
  const isMissing = (key: string) => responses[key] === undefined;
  const missing = keys.filter(isMissing).map((key) => labels[key]);

  return (
    <QuestionnairePage
      title="Thinking back on the conversation you just had, please answer the following."
      valid={missing.length === 0}
      missing={missing}
      onIncomplete={() => setAttempted(true)}
      onSubmit={onContinue}
      frameClassName="bg-black border p-8 w-10/12 mx-auto flex-1 flex flex-col justify-center"
    >
      <div className="w-full">
        {keys.map((key) =>
          key === TALK_ITEM_KEY ? (
            <NumberScale
              key={key}
              label={labels[key]}
              min={-5}
              max={5}
              leftLabel="My study partner spoke much more than I did"
              centerLabel="My study partner and I spoke the same amount"
              rightLabel="I spoke much more than my study partner did"
              value={responses[key]}
              unanswered={attempted && isMissing(key)}
              onChange={(value) => onChange(key, value)}
            />
          ) : (
            <NumberScale
              key={key}
              label={labels[key]}
              min={0}
              max={10}
              leftLabel="Not at all"
              rightLabel="Very much"
              value={responses[key]}
              unanswered={attempted && isMissing(key)}
              onChange={(value) => onChange(key, value)}
            />
          ),
        )}
      </div>
    </QuestionnairePage>
  );
}
