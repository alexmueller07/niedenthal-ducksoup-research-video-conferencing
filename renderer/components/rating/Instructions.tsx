import { useRef } from "react";
import PressKeyPrompt from "./PressKeyPrompt";
import ScrollHint from "./ScrollHint";
import { useScrollToTop } from "./scroll";

// The instruction screens, shared by the conversation-rating task and the
// short-video task.
//
// LAYOUT — Alex, 2026-09-19. This screen used to draw its text in a block with
// a fixed `pt-32` top padding and pin the "press any key" prompt with
// `absolute bottom-16`. Two things that do not know about each other, in a
// window whose height nobody controls: on the lab's shorter monitors the last
// instruction ran underneath the prompt and was simply unreadable. Ben found it
// on the first instruction of the slider task, and noted it did not happen on
// every computer — which is exactly what a layout that depends on window height
// looks like from the outside.
//
// So the screen is now a flex column: a scrolling region that takes whatever
// height is left, and the prompt as an ordinary child below it. The two cannot
// overlap at any window size, because neither is positioned over the other.
//
// Two consequences worth stating, because the first attempt got them wrong:
//
//   - the old fixed `pt-32` is gone. On a tall screen 128px of dead space above
//     the text was fine; on a short one it was 128px that the text needed. The
//     content centres itself when it fits and starts at the top when it does
//     not, which is the same behaviour at both ends and no arithmetic.
//   - a region that scrolls has to say so. The app draws no scrollbar any more
//     (App.css), so an instruction long enough to overflow would be cut off
//     mid-sentence with nothing on screen suggesting there was more. The hint
//     sits between the text and the prompt, in flow, so it cannot collide with
//     either.

interface InstructionsProps {
  instructionIndex: number;
  instructions: string[];
  instructionImages?: { [key: number]: string };
  groupSize?: number;
  onBack?: () => void;
  /** Clicking Continue. Same path as pressing a key — see utils/useAdvance.ts. */
  onContinue?: () => void;
}

function Instructions({
  instructionIndex,
  instructions,
  instructionImages,
  groupSize = 3,
  onBack,
  onContinue,
}: InstructionsProps) {
  // This screen advances in place rather than remounting, so the reset is
  // keyed on the index — a long instruction followed by a short one would
  // otherwise open scrolled down.
  useScrollToTop(instructionIndex);
  const scrollRef = useRef<HTMLDivElement>(null);

  const getVisibleInstructions = () => {
    const currentGroup = Math.floor(instructionIndex / groupSize);
    const startIndex = currentGroup * groupSize;
    const endIndex = Math.min(startIndex + groupSize, instructionIndex + 1);

    return instructions.slice(startIndex, endIndex).map((text, idx) => ({
      text,
      originalIndex: startIndex + idx,
      hasImage: instructionImages && instructionImages[startIndex + idx] !== undefined,
    }));
  };

  const formatText = (text: string) =>
    text.split("\n").map((line, index) => (
      <span key={index}>
        {line.split("\t").map((part, partIndex) => (
          <span key={partIndex}>
            {partIndex > 0 && <span className="ml-8" />}
            {part}
          </span>
        ))}
        {index < text.split("\n").length - 1 && <br />}
      </span>
    ));

  const visible = getVisibleInstructions();

  return (
    <div className="h-full w-full bg-black cursor-auto flex flex-col relative">
      {instructionIndex > 0 && onBack && (
        <button
          onClick={onBack}
          className="absolute top-10 left-10 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white border border-gray-500 rounded cursor-pointer transition-colors z-10"
        >
          ← Previous
        </button>
      )}

      {/* min-h-0 is what lets this shrink instead of pushing the prompt off the
          bottom: a flex child's default min-height is its content. */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto no-scrollbar w-full">
        {/* min-h-full + justify-center: centred while the text fits, scrolling
            from the top once it does not. */}
        <div className="min-h-full w-full max-w-2xl mx-auto px-8 py-10 flex flex-col justify-center">
          <div className="space-y-6">
            {visible.map((item, idx) => (
              <div key={item.originalIndex} className="flex flex-col justify-center">
                <p
                  className="text-2xl leading-relaxed"
                  style={{ color: idx <= instructionIndex ? "white" : "black" }}
                >
                  {formatText(item.text)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="shrink-0 w-full max-w-2xl mx-auto px-8 pb-10 flex flex-col items-center gap-4">
        <ScrollHint containerRef={scrollRef} inline />
        <div className="w-full">
          <PressKeyPrompt onContinue={onContinue} />
        </div>
      </div>
    </div>
  );
}

export default Instructions;
