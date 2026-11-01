// The "how do I get off this screen" prompt.
//
// Ben, 2026-09-19: "there are a couple of occurrences in the app of a 'press
// any key or click continue' where the continue button is missing", and
// separately, people asked to be able to click rather than having to find the
// keyboard. Both are answered here rather than screen by screen: the prompt
// now always carries a real button, and the screens that use it accept a click
// anywhere as well (see utils/useAdvance.ts).
//
// The button is the same white pill as every other Continue in the app, so a
// participant who has pressed Continue once already knows what this is.

interface PressKeyPromptProps {
  keyLabel?: string;
  text?: string;
  /**
   * Clicking the button. Optional only because the screens that mount this
   * inside a useAdvance-covered page already advance on any background click —
   * but every caller passes it, because a button that needs its container to
   * work is a button that will one day not work.
   */
  onContinue?: () => void;
  /** Continue is there but inert — PerspectiveNotice during its dwell. */
  disabled?: boolean;
}

export default function PressKeyPrompt({
  keyLabel = "any key",
  text = "to continue",
  onContinue,
  disabled = false,
}: PressKeyPromptProps) {
  return (
    <div className="p-4 bg-gray-800 rounded-lg border border-gray-600 flex flex-col items-center gap-4">
      <p className="text-white text-2xl text-center">
        Press{" "}
        {keyLabel !== "any key" ? (
          <kbd className="px-2 py-1 bg-gray-700 rounded text-sm">{keyLabel}</kbd>
        ) : (
          <span className="text-white text-2xl">any key</span>
        )}{" "}
        {text}, or click Continue
      </p>
      <button
        type="button"
        onClick={onContinue}
        disabled={disabled}
        className="px-8 py-3 rounded-lg font-semibold transition-colors bg-white text-black enabled:hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Continue
      </button>
    </div>
  );
}
