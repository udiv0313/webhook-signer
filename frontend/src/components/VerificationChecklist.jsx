import { getChecklist, getExplanation } from "../diagnostics.js";

// The inspector's verification section: each check in order (passed, failed,
// or not checked), then what happened and how to fix it.

const STATE_DISPLAY = {
  pass: { icon: "✓", text: "Passed" },
  fail: { icon: "✕", text: "Failed" },
  skipped: { icon: "–", text: "Not checked" },
};

// Each verification step with icon + text label, then what it means and how to fix it.
export default function VerificationChecklist({ verification }) {
  const steps = getChecklist(verification);
  const { summary, fix } = getExplanation(verification.code);

  return (
    <>
      <ol className="checklist">
        {steps.map((step) => (
          <li key={step.label} className={`check check-${step.state}`}>
            <span className="check-icon" aria-hidden="true">
              {STATE_DISPLAY[step.state].icon}
            </span>
            <span className="check-label">{step.label}</span>
            <span className="check-state">{STATE_DISPLAY[step.state].text}</span>
            <span className="check-detail">{step.detail}</span>
          </li>
        ))}
      </ol>

      <div className={`explanation ${verification.valid ? "explanation-pass" : "explanation-fail"}`}>
        <p>
          <strong>What happened:</strong> {summary}
        </p>
        {fix && (
          <p>
            <strong>How to fix it:</strong> {fix}
          </p>
        )}
      </div>
    </>
  );
}
