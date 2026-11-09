import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, type ApiClient } from '../../api.js';
import {
  ActionDialog,
  errText,
  fmtDate,
  fmtDateTime,
  input,
  smallButton,
  useCan,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Evidence states in plain words, with a status so colour is never the only signal. */
export const EVIDENCE_STATE: Record<string, { kind: StatusKind; text: string }> = {
  AWAITING_UPLOAD: { kind: 'GREY', text: 'Upload not finished' },
  SCANNING: { kind: 'GREY', text: 'Being scanned' },
  QUARANTINED: { kind: 'RED', text: 'Blocked by the virus scan' },
  PENDING_VERIFICATION: { kind: 'AMBER', text: 'Awaiting verification' },
  VERIFIED: { kind: 'GREEN', text: 'Verified' },
  REJECTED: { kind: 'RED', text: 'Rejected' },
};
const SUBJECT: Record<string, string> = {
  STAFF: 'Staff',
  VEHICLE: 'Vehicle',
  EQUIPMENT: 'Equipment',
  PREMISES: 'Premises',
  ORGANISATION: 'Organisation',
  SERVICE: 'Service',
};
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.csv,.txt';
const kb = (n: number | null | undefined) =>
  n == null
    ? ''
    : n < 1024 * 1024
      ? `${Math.max(1, Math.round(n / 1024))} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

/** Uploads one file, waits for the scan and returns the new version id. */
export async function uploadFile(
  api: ApiClient,
  orgId: string | null,
  file: File,
  o: { instanceIds?: string[]; title?: string; validFrom?: string; validTo?: string } = {},
): Promise<{ versionId: string; itemId: string }> {
  const req = (await api.send('POST', '/api/v1/evidence/uploads', orgId, {
    title: (o.title || file.name).slice(0, 200),
    mime: file.type || 'application/pdf',
    sizeBytes: file.size,
    ...(o.instanceIds?.length ? { requirementInstanceIds: o.instanceIds } : {}),
    ...(o.validFrom ? { validFrom: o.validFrom } : {}),
    ...(o.validTo ? { validTo: o.validTo } : {}),
  })) as { uploadUrl: string; evidenceVersionId: string; evidenceItemId: string };
  const put = await fetch(req.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': file.type || 'application/pdf' },
    body: file,
  });
  if (!put.ok) throw new ApiError(put.status, 'UPLOAD_REJECTED');
  const done = (await api.send(
    'POST',
    `/api/v1/evidence/${req.evidenceVersionId}/complete`,
    orgId,
    {},
  )) as Row | null;
  if (done && done.state === 'QUARANTINED')
    throw new ApiError(
      422,
      'UPLOAD_REJECTED',
      'The file failed the virus or type check and was not kept.',
    );
  return { versionId: req.evidenceVersionId, itemId: req.evidenceItemId };
}

/** Opens a document in a new tab through a short-lived, audited link. */
export async function openEvidence(api: ApiClient, orgId: string | null, versionId: string) {
  const win = window.open('', '_blank');
  try {
    const r = (await api.get(`/api/v1/evidence/${versionId}/download`, orgId)) as { url: string };
    if (win) win.location.href = r.url;
    else window.location.assign(r.url);
  } catch (e) {
    win?.close();
    throw e;
  }
}

/**
 * B3: upload a document for a requirement. Asks for the dates the reviewer needs: an expiry for
 * items that expire, otherwise an optional "valid until".
 */
export function UploadDialog({
  target,
  onClose,
}: {
  target: { instanceId: string; title: string; deadlineKind?: string } | null;
  onClose: () => void;
}) {
  const { api, orgId } = useApp();
  const [file, setFile] = useState<File | null>(null);
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const expiry = target?.deadlineKind === 'EXPIRY';
  const reset = () => {
    setFile(null);
    setValidFrom('');
    setValidTo('');
    onClose();
  };
  return (
    <ActionDialog
      open={target !== null}
      title={`Upload evidence for ${target?.title ?? ''}`}
      confirmLabel="Upload"
      confirmDisabled={!file || (expiry && !validTo)}
      onCancel={reset}
      fields={
        <>
          <label className="flex flex-col text-sm">
            File (PDF, image, Word, Excel, CSV or text; up to 25 MB)
            <input
              type="file"
              accept={ACCEPT}
              className={input}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col text-sm">
              Issued or valid from (optional)
              <input
                type="date"
                className={input}
                value={validFrom}
                onChange={(e) => setValidFrom(e.target.value)}
              />
            </label>
            <label className="flex flex-col text-sm">
              {expiry ? 'Expiry date (required)' : 'Valid until (optional)'}
              <input
                type="date"
                className={input}
                value={validTo}
                onChange={(e) => setValidTo(e.target.value)}
              />
            </label>
          </div>
        </>
      }
      onConfirm={async () => {
        await uploadFile(api, orgId, file!, {
          instanceIds: [target!.instanceId],
          validFrom: validFrom || undefined,
          validTo: validTo || undefined,
        });
        setFile(null);
        setValidFrom('');
        setValidTo('');
      }}
    >
      <p>
        Uploading does not make anything green. The document stays &ldquo;awaiting
        verification&rdquo; until a different person checks it against the original.
      </p>
    </ActionDialog>
  );
}

/** B4: verify (with the confirmed dates) or reject (with a reason) one document. */
export function DecisionDialog({
  doc,
  decision,
  deadlineKind,
  onClose,
}: {
  doc: Row | null;
  decision: 'ACCEPTED' | 'REJECTED';
  deadlineKind?: string;
  onClose: () => void;
}) {
  const { api, orgId } = useApp();
  const [validTo, setValidTo] = useState('');
  const shown = validTo || doc?.validTo || '';
  const expiry = deadlineKind === 'EXPIRY';
  return (
    <ActionDialog
      open={doc !== null}
      title={decision === 'ACCEPTED' ? `Verify ${doc?.title ?? ''}` : `Reject ${doc?.title ?? ''}`}
      confirmLabel={decision === 'ACCEPTED' ? 'Verify' : 'Reject'}
      danger={decision === 'REJECTED'}
      reasonLabel={
        decision === 'REJECTED' ? 'Why is it rejected? The uploader sees this' : undefined
      }
      confirmDisabled={decision === 'ACCEPTED' && expiry && !shown}
      onCancel={() => {
        setValidTo('');
        onClose();
      }}
      fields={
        decision === 'ACCEPTED' ? (
          <label className="flex flex-col text-sm">
            {expiry ? 'Confirmed expiry date (required)' : 'Confirmed valid until (optional)'}
            <input
              type="date"
              className={input}
              value={shown}
              onChange={(e) => setValidTo(e.target.value)}
            />
          </label>
        ) : undefined
      }
      onConfirm={async (reason) => {
        await api.send('POST', `/api/v1/evidence/${doc!.id}/verify`, orgId, {
          decision,
          ...(decision === 'REJECTED' ? { reason } : {}),
          ...(decision === 'ACCEPTED' && shown ? { confirmedValidTo: shown } : {}),
        });
        setValidTo('');
      }}
    >
      {decision === 'ACCEPTED' ? (
        <p>
          Confirm you have opened the document, it belongs to the right person or item, it is the
          right kind of document and the dates match. Your name is recorded as the verifier.
        </p>
      ) : (
        <p>The requirement stays not met until a new document is uploaded and verified.</p>
      )}
    </ActionDialog>
  );
}

/** One requirement's documents with view, verify and reject. */
export function EvidenceTable({
  docs,
  deadlineKind,
  caption,
  showFor,
}: {
  docs: Row[];
  deadlineKind?: string;
  caption: string;
  showFor?: boolean;
}) {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const [deciding, setDeciding] = useState<{
    doc: Row;
    d: 'ACCEPTED' | 'REJECTED';
    kind?: string;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const canVerify = can('compliance.evidence.verify');
  return (
    <>
      {err && (
        <p role="alert" className="text-sm text-red-800">
          {err}
        </p>
      )}
      <DataTable<Row>
        caption={caption}
        rows={docs}
        rowKey={(d) => d.id}
        emptyMessage="No documents uploaded yet."
        columns={[
          {
            key: 'doc',
            header: 'Document',
            cell: (d) => (
              <span>
                <strong>{d.title}</strong>
                <span className="block text-xs text-slate-700">
                  Version {d.versionNo}
                  {d.sizeBytes ? ` · ${kb(d.sizeBytes)}` : ''}
                </span>
              </span>
            ),
          },
          ...(showFor
            ? [{ key: 'for', header: 'Evidence for', cell: (d: Row) => d.forTitle ?? '' }]
            : []),
          {
            key: 'up',
            header: 'Uploaded',
            cell: (d) => (
              <span>
                {fmtDateTime(d.uploadedAt) || 'Not finished'}
                <span className="block text-xs text-slate-700">
                  by {d.uploadedByName ?? 'unknown user'}
                </span>
              </span>
            ),
          },
          {
            key: 'dates',
            header: 'Valid',
            cell: (d) =>
              d.validTo
                ? `${d.validFrom ? `${fmtDate(d.validFrom)} to ` : 'Until '}${fmtDate(d.validTo)}`
                : d.validFrom
                  ? `From ${fmtDate(d.validFrom)}`
                  : 'No dates given',
          },
          {
            key: 'state',
            header: 'State',
            cell: (d) => {
              const s = EVIDENCE_STATE[d.state] ?? { kind: 'GREY' as const, text: d.state };
              const who =
                d.decision && d.reviewerName
                  ? ` by ${d.reviewerName} on ${fmtDate(d.decidedAt)}`
                  : '';
              return (
                <span>
                  <StatusBadge status={s.kind} reason={`${s.text}${who}`} />
                  {d.decisionReason && (
                    <span className="block text-xs text-slate-700">Reason: {d.decisionReason}</span>
                  )}
                </span>
              );
            },
          },
          {
            key: 'act',
            header: 'Action',
            cell: (d) => (
              <span className="flex flex-wrap gap-1">
                {d.scanStatus === 'CLEAN' && d.uploadedAt && (
                  <button
                    className={smallButton}
                    aria-label={`View ${d.title}`}
                    onClick={() => {
                      setErr(null);
                      openEvidence(api, orgId, d.id).catch((e) => setErr(errText(e)));
                    }}
                  >
                    View
                  </button>
                )}
                {canVerify &&
                  d.state === 'PENDING_VERIFICATION' &&
                  (d.uploadedBy === me.user.id ? (
                    <span className="text-xs text-slate-700">
                      You uploaded this: another person must verify it
                    </span>
                  ) : (
                    <>
                      <button
                        className={smallButton}
                        aria-label={`Verify ${d.title}`}
                        onClick={() =>
                          setDeciding({
                            doc: d,
                            d: 'ACCEPTED',
                            kind: d.deadlineKind ?? deadlineKind,
                          })
                        }
                      >
                        Verify
                      </button>
                      <button
                        className={smallButton}
                        aria-label={`Reject ${d.title}`}
                        onClick={() =>
                          setDeciding({
                            doc: d,
                            d: 'REJECTED',
                            kind: d.deadlineKind ?? deadlineKind,
                          })
                        }
                      >
                        Reject
                      </button>
                    </>
                  ))}
              </span>
            ),
          },
        ]}
      />
      <DecisionDialog
        doc={deciding?.doc ?? null}
        decision={deciding?.d ?? 'ACCEPTED'}
        deadlineKind={deciding?.kind}
        onClose={() => setDeciding(null)}
      />
    </>
  );
}

/** Documents for one requirement, in a dialog opened from any requirement row. */
export function EvidenceDialog({
  target,
  onClose,
}: {
  target: { instanceId: string; title: string; deadlineKind?: string } | null;
  onClose: () => void;
}) {
  const { api, orgId } = useApp();
  const can = useCan();
  const [uploading, setUploading] = useState(false);
  const q = useQuery({
    queryKey: ['one', orgId, `/api/v1/requirements/instances/${target?.instanceId}/evidence`],
    queryFn: async () =>
      (await api.get(`/api/v1/requirements/instances/${target!.instanceId}/evidence`, orgId)) as {
        data: Row[];
      },
    enabled: !!target && !!orgId,
    retry: false,
  });
  if (!target) return null;
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 backdrop-blur-sm p-4"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !uploading) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="evidence-dialog-title"
        className="mt-10 w-full max-w-4xl space-y-3 rounded-lg bg-hub-card p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="evidence-dialog-title" className="text-lg font-semibold">
            Documents for {target.title}
          </h2>
          <button className={smallButton} onClick={onClose} autoFocus>
            Close
          </button>
        </div>
        {q.isLoading && <p role="status">Loading documents…</p>}
        {q.isError && <p role="alert">{errText(q.error)}</p>}
        {q.data && (
          <EvidenceTable
            docs={q.data.data}
            deadlineKind={target.deadlineKind}
            caption={`Documents for ${target.title}`}
          />
        )}
        {can('compliance.evidence.upload') && (
          <button className={smallButton} onClick={() => setUploading(true)}>
            Upload a document
          </button>
        )}
        <UploadDialog target={uploading ? target : null} onClose={() => setUploading(false)} />
      </div>
    </div>
  );
}

/** Staff "Documents" tab: every document on this person's requirements. */
export function StaffDocuments({ s }: { s: Row }) {
  const { api, orgId } = useApp();
  const reqs = (s.requirements as Row[]) ?? [];
  const results = useQueries({
    queries: reqs.map((r) => ({
      queryKey: ['one', orgId, `/api/v1/requirements/instances/${r.id}/evidence`],
      queryFn: async () =>
        (await api.get(`/api/v1/requirements/instances/${r.id}/evidence`, orgId)) as {
          data: Row[];
        },
      enabled: !!orgId,
      retry: false,
    })),
  });
  const docs = new Map<string, Row>();
  results.forEach((q, n) => {
    for (const d of q.data?.data ?? []) {
      const prev = docs.get(d.id);
      const forTitle = reqs[n]!.templateTitle as string;
      docs.set(d.id, {
        ...d,
        deadlineKind: reqs[n]!.deadlineKind,
        forTitle: prev ? `${prev.forTitle}, ${forTitle}` : forTitle,
      });
    }
  });
  const rows = [...docs.values()].sort((a, b) =>
    String(b.uploadedAt ?? '').localeCompare(String(a.uploadedAt ?? '')),
  );
  return (
    <section aria-labelledby="docs-h" className="space-y-2">
      <h2 id="docs-h" className="text-lg font-semibold">
        Evidence documents ({rows.length})
      </h2>
      {results.some((q) => q.isLoading) && <p role="status">Loading documents…</p>}
      <EvidenceTable docs={rows} caption="Evidence documents" showFor />
    </section>
  );
}

/** B4 review queue: every document waiting for a decision, oldest first. */
export function ReviewQueue() {
  const { api, orgId } = useApp();
  const q = useQuery({
    queryKey: ['one', orgId, '/api/v1/evidence/review-queue'],
    queryFn: async () => (await api.get('/api/v1/evidence/review-queue', orgId)) as { data: Row[] },
    enabled: !!orgId,
    retry: false,
  });
  const rows: Row[] = (q.data?.data ?? []).map((d) => ({
    ...d,
    deadlineKind: d.requirements[0]?.deadlineKind,
    forTitle: (d.requirements as Row[])
      .map(
        (r) => `${r.templateTitle} – ${SUBJECT[r.subjectType] ?? r.subjectType}: ${r.subjectLabel}`,
      )
      .join('; '),
  }));
  const waiting = rows.filter((r) => !r.mine).length;
  return (
    <section aria-labelledby="queue-h" className="space-y-2">
      <h2 id="queue-h" className="text-lg font-semibold">
        Evidence waiting for review ({rows.length})
      </h2>
      <p className="text-sm text-slate-700">
        Open each document, check it against the requirement and the person or item it is for, then
        verify or reject it. You cannot verify documents you uploaded yourself
        {rows.length > waiting ? ` (${rows.length - waiting} of these are yours)` : ''}.
      </p>
      {q.isLoading && <p role="status">Loading…</p>}
      {q.isError && <p role="alert">{errText(q.error)}</p>}
      {q.data && <EvidenceTable docs={rows} caption="Evidence waiting for review" showFor />}
    </section>
  );
}
