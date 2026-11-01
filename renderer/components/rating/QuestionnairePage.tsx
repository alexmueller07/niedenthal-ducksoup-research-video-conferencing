import { useState } from "react";
import ConfirmationModal from "./ConfirmationModal";
import ScrollHint from "./ScrollHint";
import { useScrollToTop } from "./scroll";

// Shared questionnaire scaffold. Visuals follow Suhaas's original app (black
// page, bordered p-8 frame, white px-8 py-3 Continue button) with the two
// behaviors Randy's RAs asked for on top:
//   - the instruction header stays pinned to the top while the page scrolls
//   - the Continue button is frozen in the bottom-right corner
//
// Every page scrolls. The old lockViewport escape hatch (Demographics) pinned
// the page to one viewport height with overflow-hidden, which clipped the
// bottom questions on short laptops with no scroll path — the same failure
// RatingOverlay had (see RatingOverlay.tsx).
//
// Added 2026-09-19 from Ben's list, both about a participant not knowing what
// they have not done:
//   - `missing` — the page tells the confirmation dialog which questions are
//     blank, and `attempted` (returned to the caller) turns on the asterisks
//     next to them. A page that can list its items passes them; one that
//     cannot passes nothing and behaves as before.
//   - a scroll indicator, because the app no longer draws a scrollbar.
interface QuestionnairePageProps {
  /** Pinned instruction text. Omit for single-screen pages with no header. */
  title?: string;
  /** Whether every question is answered; if not, Continue opens the modal. */
  valid: boolean;
  /** Called when the participant continues (directly or via the modal). */
  onSubmit: () => void;
  /**
   * The labels of the questions currently unanswered, in page order. Listed in
   * the confirmation dialog.
   */
  missing?: string[];
  /**
   * Called the first time Continue is pressed with something blank, so the page
   * can mark its own unanswered questions. Pages pass a setter for the flag
   * they hand to NumberScale/MatrixQuestion as `unanswered`.
   */
  onIncomplete?: () => void;
  confirmMessage?: string;
  confirmText?: string;
  cancelText?: string;
  /** Suhaas's inner frame classes; PartnerSliders overrides the width. */
  frameClassName?: string;
  children: React.ReactNode;
}

export default function QuestionnairePage({
  title,
  valid,
  onSubmit,
  missing,
  onIncomplete,
  confirmMessage,
  confirmText,
  cancelText,
  frameClassName = "bg-black border p-8 text-center max-w-7xl mx-auto flex-1 flex flex-col justify-center",
  children,
}: QuestionnairePageProps) {
  // Every questionnaire opens at its own top, not at wherever the previous
  // page was scrolled to — see utils/scroll.ts.
  useScrollToTop();
  const [showConfirm, setShowConfirm] = useState(false);

  const handleContinue = () => {
    if (valid) {
      onSubmit();
    } else {
      onIncomplete?.();
      setShowConfirm(true);
    }
  };

  return (
    <div className="min-h-full w-full flex flex-col items-center justify-center bg-black pb-24">
      {title && (
        <div className="sticky top-0 z-40 w-full bg-black border-b border-white px-8 py-4">
          <h2 className="text-white text-2xl font-bold text-center">{title}</h2>
        </div>
      )}

      <div className={frameClassName}>{children}</div>

      <div className="fixed bottom-8 right-8 z-40">
        <button
          type="button"
          onClick={handleContinue}
          className="px-8 py-3 rounded-lg font-semibold transition-colors bg-white text-black hover:bg-gray-200"
        >
          Continue
        </button>
      </div>

      {/* Sits above the Continue button's row so the two never collide. */}
      <ScrollHint bottomClass="bottom-24" />

      <ConfirmationModal
        isOpen={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={() => {
          setShowConfirm(false);
          onSubmit();
        }}
        message={confirmMessage}
        confirmText={confirmText}
        cancelText={cancelText}
        missing={missing}
      />
    </div>
  );
}
