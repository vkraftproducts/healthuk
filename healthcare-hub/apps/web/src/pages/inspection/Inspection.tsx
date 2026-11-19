import type { InspectionOverviewDto } from '@hub/contracts';
import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Alert, Card, Spin, Space, Typography } from 'antd';
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
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        {k.applicable === 0
          ? 'No requirements set up for this key question.'
          : `${k.verified} of ${k.applicable} requirements have verified evidence` +
            (gaps > 0 ? ` (${gaps} not yet)` : '') +
            '. Internal measure — not a CQC rating.'}
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        Open actions from audits: {k.openActions}
      </Typography.Paragraph>
      {k.gaps.length > 0 && (
        <ul aria-label={`${k.label} gaps`} style={{ paddingLeft: 20, marginBottom: 12 }}>
          {k.gaps.map((g, i) => (
            <li key={`${g.title}-${i}`}>
              <Typography.Text type="secondary">
                {g.title}: {g.reasonText}
              </Typography.Text>
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
        <ul aria-label={`${k.label} policies`} style={{ paddingLeft: 20, marginTop: 12 }}>
          {k.policies.map((p) => (
            <li key={p.code}>
              <Typography.Text type="secondary">
                {p.code} {p.title}
                {p.version ? ` (version ${p.version})` : ' (not published)'}
              </Typography.Text>
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
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div>
        <Typography.Title level={2} style={{ margin: 0 }}>
          Inspection view
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Read-only. Your viewing is recorded in the audit log. Staff checks show as verified or not,
          without DBS or health details.
        </Typography.Paragraph>
      </div>
      {q.isError && (
        <Alert
          type="error"
          showIcon
          role="alert"
          message="Source unavailable. Could not load the inspection view."
        />
      )}
      {q.isLoading && (
        <Spin aria-label="Loading">
          <Typography.Paragraph role="status">Loading…</Typography.Paragraph>
        </Spin>
      )}
      {d && (
        <>
          <Card size="small" aria-label="Rating" title="Rating published by CQC">
            <Typography.Paragraph>
              {d.publishedRating
                ? `${words(d.publishedRating.rating)} – ${d.publishedRating.locationName}` +
                  (d.publishedRating.publishedOn
                    ? `, published ${fmtDate(d.publishedRating.publishedOn)}`
                    : '')
                : 'No CQC rating recorded.'}
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              Evidence coverage:{' '}
              {d.coverage.percent === null
                ? 'No requirements set up'
                : `${d.coverage.percent}% (${d.coverage.numerator} of ${d.coverage.denominator})`}{' '}
              – {d.coverage.label}
            </Typography.Paragraph>
          </Card>
          {d.keyQuestions.map((k) => (
            <KeyQuestionPanel key={k.domain} k={k} />
          ))}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Generated {fmtDateTime(d.generatedAt)}
          </Typography.Text>
        </>
      )}
    </Space>
  );
}