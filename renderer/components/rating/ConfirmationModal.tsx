import { useEffect, useState } from "react";

// One wording for "you left something blank", used everywhere.
//
// Randy, 2026-07-30: the video task's version ("Hey, you didn't answer every
// question on this screen…") read as too informal next to the questionnaires'.
// Rather than fix that one string, the formal wording is the component's default
// so a new page gets it without anyone having to remember.
//
// Ben, 2026-09-19, two things at once:
//
//   - "People clicking through really fast may not stop to read the 'you did not
//     answer all the questions, are you sure you want to continue?'" So the way
//     out of the dialog is no longer symmetrical. Go back is the primary button
//     and holds the focus; Continue anyway is a quieter outline button and is
//     inert for the first two seconds, which is longer than a double-click and
//     shorter than anyone deliberate would notice.
//   - "could that be paired with something that indicates which questions were
//     missed?" So the dialog names them. A participant who skipped one question
//     on a page of twenty could previously only be told that they had.
//
// The pages themselves also mark their unanswered questions — see
// QuestionnairePage, NumberScale and MatrixQuestion — so the information is
// still there after the dialog closes.

export const INCOMPLETE_MESSAGE =
  "There are unanswered questions on this page. Would you like to continue?";

/** How long "Continue anyway" stays inert after the dialog opens. */
export const CONFIRM_DELAY_MS = 2000;

/** Most questions we list by name before summarising the rest. */
const MAX_LISTED = 6;

interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  /**
   * The questions left blank, in the order they appear on the page. Optional:
   * a page that cannot enumerate its own items (a single free-text box) passes
   * nothing and the dialog reads exactly as it did before.
   */
  missing?: string[];
}

export default function ConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message = INCOMPLETE_MESSAGE,
  confirmText = "Continue anyway",
  cancelText = "Go back and answer",
  missing,
}: ConfirmationModalProps) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setArmed(false);
      return;
    }
    const id = window.setTimeout(() => setArmed(true), CONFIRM_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [isOpen]);

  if (!isOpen) return null;

  const listed = missing?.slice(0, MAX_LISTED) ?? [];
  const overflow = (missing?.length ?? 0) - listed.length;

  // bg-black/50, not bg-opacity-50: the bg-opacity-* utilities were removed in
  // Tailwind v4, so the old class silently rendered the backdrop fully opaque.
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 max-w-lg mx-4">
        {title && <h2 className="text-white text-xl font-bold mb-4">{title}</h2>}
        <p className="text-white text-lg mb-4">{message}</p>

        {missing && missing.length > 0 && (
          <div className="mb-6 border-l-2 border-yellow-500 pl-4">
            <p className="text-yellow-400 text-sm font-semibold mb-2">
              {missing.length === 1
                ? "This question has no answer:"
                : `These ${missing.length} questions have no answer:`}
            </p>
            <ul className="text-gray-300 text-sm space-y-1 max-h-56 overflow-y-auto no-scrollbar">
              {listed.map((item, index) => (
                <li key={index}>• {item}</li>
              ))}
              {overflow > 0 && (
                <li className="text-gray-400">
                  …and {overflow} more, marked with{" "}
                  <span className="text-red-400 font-bold">*</span> on the page.
                </li>
              )}
            </ul>
          </div>
        )}

        {/* Go back first and primary: the safe answer should be the easy one.
            Continue anyway stays reachable — skipping is allowed — but it has
            to be chosen rather than landed on. */}
        <div className="flex space-x-4 justify-between items-center">
          <button
            onClick={onConfirm}
            disabled={!armed}
            className="px-6 py-2 border border-gray-500 text-gray-300 rounded-lg transition-colors enabled:hover:bg-gray-700 enabled:hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {confirmText}
          </button>
          <button
            autoFocus
            onClick={onClose}
            className="px-6 py-2 bg-white text-black rounded-lg font-semibold hover:bg-gray-200 transition-colors"
          >
            {cancelText}
          </button>
        </div>
      </div>
    </div>
  );
}
