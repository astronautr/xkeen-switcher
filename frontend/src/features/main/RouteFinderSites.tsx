import { useEffect, useId, useRef, type Dispatch, type SetStateAction } from "react";
import { StaleSessionError } from "../../api/client";
import { useSaveConnectivity } from "../../api/mutations";
import { useConnectivity } from "../../api/queries";
import { useNotifications, type SiteDraft } from "../../app/AppSessionProvider";
import { Button } from "../../ui/Button";
import { TestSitesEditor, testSitesSaveError, testSitesSavedMessage } from "../settings/TestSitesEditor";

export type { SiteDraft } from "../../app/AppSessionProvider";
type Props = {
  targets?: string[];
  running: boolean;
  hasResults: boolean;
  draft: SiteDraft | null;
  setDraft: Dispatch<SetStateAction<SiteDraft | null>>;
};

function hostname(url: string) {
  try { return new URL(url).hostname; } catch { return url; }
}

export function RouteFinderSites({ targets, running, hasResults, draft, setDraft }: Props) {
  const query = useConnectivity();
  const urls = targets ?? query.data?.config.check_urls ?? [];
  const remoteKey = JSON.stringify(targets);
  useEffect(() => {
    if (targets && query.data && JSON.stringify(query.data.config.check_urls) !== remoteKey) void query.refetch();
  }, [remoteKey]);
  const mutation = useSaveConnectivity();
  const { publish } = useNotifications();
  const description = useId();
  const wrapper = useRef<HTMLDivElement>(null);

  function closeEditor() {
    setDraft(null);
    requestAnimationFrame(() => wrapper.current?.querySelector<HTMLButtonElement>(".route-sites-edit")?.focus());
  }
  async function save() {
    if (!draft || draft.saving) return;
    setDraft({ ...draft, saving: true, error: undefined });
    try {
      const result = await mutation.mutateAsync({ check_urls: draft.urls.map(url => url.trim()) });
      publish(testSitesSavedMessage(urls, result.config.check_urls));
      closeEditor();
    } catch (error) {
      if (!(error instanceof StaleSessionError)) setDraft(current => current && ({ ...current, saving: false, error: testSitesSaveError(error) }));
    }
  }
  const busyMessage = "Test sites can't change while routes are being checked.";
  return <div ref={wrapper} className="route-sites" data-editing={draft ? "true" : undefined} data-marker="route-finder-sites">
    {draft ? <>
      <span className="route-sheet-label">Test sites</span>
      <TestSitesEditor urls={draft.urls} maxUrls={query.data?.max_urls ?? draft.urls.length} disabled={draft.saving}
        onChange={next => setDraft({ ...draft, urls: next, error: undefined })} hasResults={hasResults}
        actions={<>
          <Button variant="bracket" className="t-btn" marker="route-sites-cancel" disabled={draft.saving} onClick={closeEditor}>cancel</Button>
          <Button variant="bracket" className="t-btn primary" marker="route-sites-save" disabled={draft.saving} onClick={() => void save()}>save</Button>
        </>} />
      {draft.error && <p className="route-sheet-notice" data-marker="route-sites-error" role="alert">{draft.error}</p>}
    </> : <>
      <span className="route-sheet-label">Test sites · {query.data ? urls.length : "…"}</span>
      <span className="route-sites-hosts" title={urls.join("\n")}>{urls.map(hostname).join(", ")}</span>
      <Button marker="route-sites-edit" className="t-btn route-sites-edit" variant="bracket" aria-label="Edit test sites"
        aria-disabled={running || !query.data} aria-describedby={description} onClick={() => {
          if (running || !query.data) return;
          setDraft({ urls: [...urls], base: [...urls] });
          requestAnimationFrame(() => wrapper.current?.querySelector("input")?.focus());
        }}>edit</Button>
      <span id={description} className="visually-hidden">{[...urls, running ? busyMessage : ""].join(" ")}</span>
      {query.isError && <p className="route-sheet-notice" role="alert">Could not load test sites.</p>}
    </>}
  </div>;
}
