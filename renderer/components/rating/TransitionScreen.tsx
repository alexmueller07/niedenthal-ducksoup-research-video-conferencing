import PerspectiveNotice from "./PerspectiveNotice";

// The screen that announces whose feelings the next block is about.
//
// Randy, 2026-07-30: participants were missing the perspective switch, and a
// participant who is bored of the study will press through an announcement
// screen without reading it. So this screen holds itself open: keys do nothing
// for the first few seconds, and the remaining time is shown so the wait reads
// as deliberate rather than as a frozen app.
//
// The dwell is a data-quality control, not decoration — a block rated from the
// wrong perspective is unusable, and there is no way to detect it after the
// fact.
//
// Randy, 2026-08-05: same wait screen everywhere, and three seconds rather than
// six. The wording and the countdown now come from PerspectiveNotice, which the
// video task uses for exactly the same announcement between its own two
// perspectives — one component so the two tasks cannot drift apart.

interface TransitionScreenProps {
  ratingTarget: "self" | "partner";
  onContinue: () => void;
}

function TransitionScreen({ ratingTarget, onContinue }: TransitionScreenProps) {
  const self = ratingTarget === "self";
  return (
    <div className="absolute inset-0 z-20">
      <PerspectiveNotice
        headline={
          self ? (
            <>
              You will now be rating{" "}
              <span className="font-bold underline">YOUR OWN FEELINGS</span> during the
              conversation.
            </>
          ) : (
            <>
              You will now be rating{" "}
              <span className="font-bold underline">YOUR PARTNER&rsquo;S FEELINGS</span>{" "}
              during the conversation.
            </>
          )
        }
        subline={
          self ? (
            <>
              Think about how <span className="font-bold underline">YOU</span> were feeling,
              moment to moment.
            </>
          ) : (
            <>
              Think about how <span className="font-bold underline">YOUR PARTNER</span> was
              feeling, moment to moment.
            </>
          )
        }
        onContinue={onContinue}
      />
    </div>
  );
}

export default TransitionScreen;
