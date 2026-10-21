import { useRef, useState } from "react";
import type { Diagnostic } from "../shared/diagnostics.js";

export function ErrorNotice({
  message,
  diagnostic,
}: {
  message: string;
  diagnostic: Diagnostic | null;
}) {
  const text = useRef<HTMLTextAreaElement>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const report = diagnostic ? JSON.stringify(diagnostic, null, 2) : "";
  return (
    <div className="error-notice">
      <p role="alert" className="notice">
        {message}
      </p>
      {diagnostic && (
        <details className="diagnostic" onToggle={() => setCopyStatus("")}>
          <summary>诊断信息</summary>
          <textarea
            ref={text}
            aria-label="脱敏诊断信息"
            readOnly
            value={report}
            spellCheck={false}
          />
          <div className="diagnostic-actions">
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(report);
                  setCopyStatus("诊断信息已复制。");
                } catch {
                  text.current?.focus();
                  text.current?.select();
                  setCopyStatus("自动复制不可用，诊断信息已选中。");
                }
              }}
            >
              复制诊断信息
            </button>
            <span role="status">{copyStatus}</span>
          </div>
        </details>
      )}
    </div>
  );
}
