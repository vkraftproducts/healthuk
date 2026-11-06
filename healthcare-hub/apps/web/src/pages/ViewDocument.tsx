import { useEffect, useRef, useState } from 'react';
import { useApp } from '../shell/AppContext.js';

type Version = {
  id: string;
  state: string;
  scanStatus: string;
  title: string;
  mime: string | null;
};
type Shown = { url: string; mime: string; title: string };

/** Shown in the page: the detected type of files that passed the scan, never a guess. */
const PREVIEWABLE = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

/**
 * Shows the document behind a requirement on screen: the latest verified one, or, when nothing is
 * verified yet, the latest one awaiting review (so a reviewer can look before deciding). The file
 * is fetched through the API's short-lived, audited link and displayed from memory; nothing is
 * downloaded unless the viewer asks to. Only files that passed the scan can be opened.
 */
export function ViewDocument({ instanceId, label }: { instanceId: string; label: string }) {
  const { api, orgId } = useApp();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);

  async function open() {
    setNote(null);
    setBusy(true);
    try {
      const { data } = (await api.get(
        `/api/v1/requirements/instances/${instanceId}/evidence`,
        orgId,
      )) as { data: Version[] };
      const clean = data.filter((v) => v.scanStatus === 'CLEAN' && v.state !== 'REJECTED');
      const pick = clean.find((v) => v.state === 'VERIFIED') ?? clean[0];
      if (!pick) {
        setNote('No document on file yet.');
        return;
      }
      const { url } = (await api.get(`/api/v1/evidence/${pick.id}/download`, orgId)) as {
        url: string;
      };
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const mime = pick.mime ?? 'application/octet-stream';
      // Typed from the scan result, so the browser never sniffs the file into something else.
      const blob = new Blob([await res.arrayBuffer()], { type: mime });
      setShown({ url: URL.createObjectURL(blob), mime, title: pick.title });
    } catch {
      setNote('The document could not be opened. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (shown) URL.revokeObjectURL(shown.url);
    setShown(null);
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
        {busy ? 'Opening…' : 'View document'}
      </button>
      {note && (
        <span role="status" className="text-sm text-slate-700">
          {note}
        </span>
      )}
      {shown && <DocumentViewer doc={shown} onClose={close} />}
    </span>
  );
}

function DocumentViewer({ doc, onClose }: { doc: Shown; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, [onClose]);
  const canShow = PREVIEWABLE.includes(doc.mime);
  const fileName = `${doc.title}${doc.mime === 'application/pdf' ? '.pdf' : ''}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="document-viewer-title"
        className="flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-white shadow-xl"
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-hub-line px-4 py-3">
          <h2 id="document-viewer-title" className="mr-auto text-base font-bold text-hub-navy">
            {doc.title}
          </h2>
          <a
            href={doc.url}
            download={fileName}
            className="rounded-md border border-hub-line px-3 py-1.5 text-sm font-medium text-hub-navy hover:bg-hub-row"
          >
            Download
          </a>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-md bg-hub-teal px-3 py-1.5 text-sm font-semibold text-white"
          >
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 bg-slate-100">
          {doc.mime === 'application/pdf' ? (
            <iframe title={doc.title} src={doc.url} className="h-full w-full border-0" />
          ) : canShow ? (
            <div className="flex h-full items-center justify-center overflow-auto p-4">
              <img src={doc.url} alt={doc.title} className="max-h-full max-w-full" />
            </div>
          ) : (
            <p className="p-6 text-sm text-slate-700">
              This type of file cannot be shown here. Use Download to open it on your device.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
