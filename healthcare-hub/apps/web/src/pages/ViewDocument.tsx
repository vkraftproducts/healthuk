import { useState } from 'react';
import { useApp } from '../shell/AppContext.js';

type Version = { id: string; state: string; scanStatus: string };

/**
 * Opens the document behind a requirement in a new tab: the latest verified one, or, when nothing
 * is verified yet, the latest one awaiting review (so a reviewer can look before deciding). Only
 * files that passed the scan can be opened; the API checks access and records each download.
 */
export function ViewDocument({ instanceId, label }: { instanceId: string; label: string }) {
  const { api, orgId } = useApp();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function open() {
    setNote(null);
    // Opened now, while the click still counts, or the browser blocks it as a pop-up.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    setBusy(true);
    try {
      const { data } = (await api.get(
        `/api/v1/requirements/instances/${instanceId}/evidence`,
        orgId,
      )) as { data: Version[] };
      const clean = data.filter((v) => v.scanStatus === 'CLEAN' && v.state !== 'REJECTED');
      const pick = clean.find((v) => v.state === 'VERIFIED') ?? clean[0];
      if (!pick) {
        tab?.close();
        setNote('No document on file yet.');
        return;
      }
      const { url } = (await api.get(`/api/v1/evidence/${pick.id}/download`, orgId)) as {
        url: string;
      };
      if (tab) tab.location.href = url;
      else setNote('Your browser blocked the new tab. Allow pop-ups for this site and try again.');
    } catch {
      tab?.close();
      setNote('The document could not be opened. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => void open()}
        aria-label={`View document for ${label}`}
        className="rounded-md border border-hub-line bg-white px-2.5 py-1 text-sm font-medium text-hub-navy hover:bg-hub-row"
      >
        View document
      </button>
      {note && (
        <span role="status" className="text-sm text-slate-700">
          {note}
        </span>
      )}
    </span>
  );
}
