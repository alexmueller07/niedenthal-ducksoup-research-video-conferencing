import { useRef } from "react";
import ConfirmationModal from "./ConfirmationModal";
import ScrollHint from "./ScrollHint";
import { useScrollElementToTop } from "./scroll";

// The writing + elicitation screen shown whenever the video pauses, and once
// more after the video runs out.
//
// LAYOUT — Alex, 2026-08-04. This screen used to be a dead-centred flex column
// inside a fixed-height, overflow-hidden parent: once the content grew taller
// than the window (which it does on a laptop screen), it was clipped at BOTH
// ends, and the "Press Tab to continue" prompt at the bottom was the first
// thing to disappear. A participant on a short screen had no visible way off
// the page at all.
//
// So: the overlay scrolls, the content starts from the top on a short screen
// (and only centres when there is room to spare), and Continue is a real button
// pinned to the bottom-right corner the same way every other page in the app
// does it. Tab still submits — it is the documented key and the RAs' habit —
// but it is no longer the only way through.

interface RatingOverlayProps {
  currentRatingTarget: "self" | "partner";
  textInput: string;
  setTextInput: (v: string) => void;
  numberScale: number | undefined;
  setNumberScale: (v: number | undefined) => void;
  attemptedSubmit: boolean;
  /** True on the screen that follows the end of the video. */
  isFinal?: boolean;
  /** Same submit path as the Tab key. */
  onSubmit: () => void;
  onConfirmIncomplete: () => void;
  onDismissIncomplete: () => void;
}

function RatingOverlay({
  currentRatingTarget,
  textInput,
  setTextInput,
  numberScale,
  setNumberScale,
  attemptedSubmit,
  isFinal = false,
  onSubmit,
  onConfirmIncomplete,
  onDismissIncomplete,
}: RatingOverlayProps) {
  // This overlay is its own scroll container (it is drawn over the video),
  // so #root is not what needs resetting here — see utils/scroll.ts.
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollElementToTop(scrollRef);

  return (
    <div
      ref={scrollRef}
      className="h-full w-full overflow-y-auto no-scrollbar bg-black cursor-auto"
    >
      <div className="min-h-full flex flex-col justify-center max-w-2xl mx-auto px-8 py-12 pb-32">
        {isFinal && (
          <p className="text-gray-400 text-lg uppercase tracking-widest mb-4">
            Last part of the video
          </p>
        )}
        <h1 className="text-white text-2xl mb-6">
          Please use the box below to write about how{" "}
          <span className="font-bold">
            {currentRatingTarget === "self" ? "YOU were" : "YOUR PARTNER was"}
          </span>{" "}
          feeling during the part of the conversation you just watched.
        </h1>

        <div className="space-y-6">
          <textarea
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            className="w-full h-48 p-4 text-white bg-gray-800 border border-white rounded-lg resize-none focus:outline-none focus:border-blue-400 text-xl"
            placeholder="Type your response here..."
            autoFocus
          />

          <div>
            <label className="block text-white text-2xl mb-6 mt-6">
              To what extent do you feel that{" "}
              <span className="font-bold">
                {currentRatingTarget === "self" ? "YOUR PARTNER" : "YOU"}
              </span>{" "}
              elicited these feelings in{" "}
              <span className="font-bold">
                {currentRatingTarget === "self" ? "YOU" : "YOUR PARTNER"}
              </span>
              ? Click the corresponding number.
            </label>
            <div className="flex justify-between items-center">
              <span className="text-white text-xl">Not at all</span>
              <div className="flex justify-center items-center space-x-4">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((point) => (
                  <div key={point} className="flex flex-col items-center">
                    <button
                      onClick={() => setNumberScale(point)}
                      className={`w-8 h-8 rounded-full border-2 transition-all duration-200 ${
                        numberScale === point
                          ? "bg-white border-white"
                          : "bg-transparent border-white hover:bg-gray-600"
                      }`}
                    />
                    <span className="text-white text-xs mt-1">{point}</span>
                  </div>
                ))}
              </div>
              <span className="text-white text-xl">Very</span>
            </div>
            <p className="text-center text-white text-lg mt-6">
              Selected: {numberScale ?? "—"}
            </p>
          </div>

          <p className="text-gray-400 text-base text-center">
            Press <kbd className="px-2 py-1 bg-gray-700 rounded text-sm">Tab</kbd>{" "}
            or click Continue.
          </p>
        </div>
      </div>

      {/* Pinned, so it is reachable no matter how short the window is. */}
      <div className="fixed bottom-8 right-8 z-40">
        <button
          type="button"
          onClick={onSubmit}
          className="px-8 py-3 rounded-lg font-semibold transition-colors bg-white text-black hover:bg-gray-200"
        >
          Continue
        </button>
      </div>

      {/* This overlay scrolls inside itself rather than inside #root, so the
          hint has to be pointed at it explicitly — see utils/scroll.ts. */}
      <ScrollHint containerRef={scrollRef} bottomClass="bottom-24" />

      <ConfirmationModal
        isOpen={attemptedSubmit}
        onClose={onDismissIncomplete}
        onConfirm={onConfirmIncomplete}
        missing={[
          ...(textInput.trim() === "" ? ["The written description of the feelings"] : []),
          ...(numberScale === undefined
            ? ["To what extent these feelings were elicited (1-9)"]
            : []),
        ]}
      />
    </div>
  );
}

export default RatingOverlay;
