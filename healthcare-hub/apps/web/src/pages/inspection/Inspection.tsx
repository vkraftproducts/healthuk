import type { InspectionOverviewDto } from '@hub/contracts';
import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Section, fmtDate, fmtDateTime, words } from '../../components.js';
import { useOne } from '../settings/hooks.js';

type KeyQuestion = InspectionOverviewDto['keyQuestions'][number];
const OUTCOME: Record<string, StatusKind> = { GREEN: 'GREEN', AMBER: 'AMBER', RED: 'RED' };
const OUTCOME_WORDS: Record<string, string> = {
  GREEN: 'Compliant',
  AMBER: 'Partly compliant',
  RED: 'Non-compliant',
};

function KeyQuestionPanel({ k }: { k: KeyQuestion }) {
  const gaps = k.applicable - k.verified;
  return (
    <Section title={k.label}>
      <p className="text-sm">
        {k.applicable === 0
          ? 'No requirements set up for this key question.'
          : `${k.verified} of ${k.applicable} requirements have verified evidence` +
            (gaps > 0 ? ` (${gaps} not yet)` : '') +
            '. Internal measure — not a CQC rating.'}
      </p>
      <p className="text-sm">Open actions from audits: {k.openActions}</p>
      {k.gaps.length > 0 && (
        <ul aria-label={`${k.label} gaps`} className="list-disc pl-5 text-sm">
          {k.gaps.map((g, i) => (
            <li key={`${g.title}-${i}`}>
              {g.title}: {g.reasonText}
            </li>
          ))}
        </ul>
      )}
      <DataTable
        caption={`${k.label} audits`}
        rows={k.audits}
        rowKey={(a) => a.id}
        emptyMessage="No submitted audits for this key question."
        columns={[
          { key: 'code', header: 'Audit', cell: (a) => `${a.code} ${a.title}` },
          { key: 'at', header: 'Submitted', cell: (a) => fmtDateTime(a.submittedAt) },
          {
            key: 'outcome',
            header: 'Result',
            cell: (a) =>
              a.outcome ? (
                <StatusBadge
                  status={OUTCOME[a.outcome] ?? 'GREY'}
                  reason={OUTCOME_WORDS[a.outcome] ?? words(a.outcome)}
                />
              ) : (
                'Not yet reviewed'
              ),
          },
        ]}
      />
      {k.policies.length > 0 && (
        <ul aria-label={`${k.label} policies`} className="list-disc pl-5 text-sm">
          {k.policies.map((p) => (
            <li key={p.code}>
              {p.code} {p.title}
              {p.version ? ` (version ${p.version})` : ' (not published)'}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * Read-only inspection view by key question (WORKFLOWS L5): the auditor's home page. Every view is
 * logged on the server; staff DBS and health details are never shown here.
 */
export function Inspection() {
  const q = useOne<InspectionOverviewDto>('/api/v1/inspection/overview');
  const d = q.data;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Inspection view</h1>
      <p className="text-sm">
        Read-only. Your viewing is recorded in the audit log. Staff checks show as verified or not,
        without DBS or health details.
      </p>
      {q.isError && (
        <p role="alert" className="rounded border border-red-700 bg-red-50 p-2 text-sm">
          Source unavailable. Could not load the inspection view.
        </p>
      )}
      {q.isLoading && <p role="status">Loading…</p>}
      {d && (
        <>
          <section
            aria-label="Rating"
            className="rounded-lg border border-hub-line bg-hub-card p-4"
          >
            <h2 className="font-semibold">Rating published by CQC</h2>
            <p>
              {d.publishedRating
                ? `${words(d.publishedRating.rating)} – ${d.publishedRating.locationName}` +
                  (d.publishedRating.publishedOn
                    ? `, published ${fmtDate(d.publishedRating.publishedOn)}`
                    : '')
                : 'No CQC rating recorded.'}
            </p>
            <p className="mt-2 text-sm">
              Evidence coverage:{' '}
              {d.coverage.percent === null
                ? 'No requirements set up'
                : `${d.coverage.percent}% (${d.coverage.numerator} of ${d.coverage.denominator})`}{' '}
              – {d.coverage.label}
            </p>
          </section>
          {d.keyQuestions.map((k) => (
            <KeyQuestionPanel key={k.domain} k={k} />
          ))}
          <p className="text-xs text-slate-600">Generated {fmtDateTime(d.generatedAt)}</p>
        </>
      )}
    </div>
  );
}
