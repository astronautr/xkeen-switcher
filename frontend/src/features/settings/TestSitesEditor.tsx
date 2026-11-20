import type { ReactNode } from "react";
import { ApiError, classifyError } from "../../api/client";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { errorMessage } from "../../ui/format";

export function testSitesSaveError(error: unknown) {
  if (error instanceof ApiError && error.code === "busy") return error.message;
  if (error instanceof ApiError && (error.acceptanceUnknown || classifyError(error) === "unknown")) {
    return "Save not confirmed. Your changes are kept. Review the test sites before saving again.";
  }
  return errorMessage(error, "Could not save test sites.");
}

export function testSitesSavedMessage(previous: readonly string[], saved: readonly string[]) {
  return previous.length === saved.length && previous.every((url, index) => url === saved[index])
    ? "Test sites saved" : "Test sites saved · earlier route results are stale";
}

type Props = {
  urls: string[];
  maxUrls: number;
  onChange: (urls: string[]) => void;
  hasResults?: boolean;
  disabled?: boolean;
  actions?: ReactNode;
};

export function TestSitesEditor({ urls, maxUrls, onChange, hasResults, disabled, actions }: Props) {
  return (
    <>
      <p className="t-note connectivity-note">
        Shared by the route finder, server route checks and failover.
        {hasResults && " Changing sites expires earlier results."}
      </p>
      <div className="connectivity-list" data-variant="fields" role="group" aria-label="Test sites">
        {urls.map((url, index) => (
          <div className="connectivity-row" key={index}>
            <Field marker="connectivity-url-input" type="url" aria-label={`test site ${index + 1}`} value={url}
              placeholder="https://example.com/health" spellCheck={false} disabled={disabled}
              onChange={(event) => onChange(urls.map((old, at) => at === index ? event.currentTarget.value : old))} />
            <button type="button" data-marker="btn-remove-connectivity-url" className="connectivity-remove"
              disabled={disabled || urls.length <= 1} aria-label={`Remove test site ${index + 1}`}
              onClick={() => onChange(urls.filter((_, at) => at !== index))}>×</button>
          </div>
        ))}
      </div>
      <div className={"connectivity-actions" + (actions ? " route-sites-actions" : "")}>
        <Button marker="btn-add-connectivity-url" className="t-btn" variant="bracket"
          disabled={disabled || urls.length >= maxUrls} onClick={() => onChange([...urls, ""])}>add site</Button>
        {actions}
      </div>
    </>
  );
}
