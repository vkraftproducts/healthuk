import type { TenantTx } from '@hub/db';
import { strToU8, zipSync } from 'fflate';
import type { BlobStore } from './storage.js';

/**
 * Full organisation export (PRD 4.12 "full export with attachments and stable IDs"). One JSON file
 * per table with every row the requester may see (row-level security applies), clean attachments
 * under their evidence version id, and a manifest. Secrets and device tokens are left out.
 */
const TABLES = [
  'organisation',
  'location',
  'membership',
  'role',
  'requirementTemplate',
  'requirementTemplateVersion',
  'requirementInstance',
  'applicabilityDecision',
  'dueDateChange',
  'evidenceItem',
  'evidenceVersion',
  'evidenceLink',
  'verification',
  'alert',
  'staff',
  'staffLifecycleEvent',
  'staffRoleApproval',
  'staffRestriction',
  'staffRecord',
  'roleRequirement',
  'staffCorrectionRequest',
  'vehicle',
  'vehicleLocationHistory',
  'odometerReading',
  'maintenancePlan',
  'maintenanceEvent',
  'equipmentAsset',
  'inspectionRegime',
  'vdiTemplate',
  'vdi',
  'vdiItemResult',
  'vdiAmendment',
  'cleaningRecord',
  'defect',
  'defectRelease',
  'fuelExpense',
  'auditTemplate',
  'auditTemplateVersion',
  'auditRun',
  'auditSample',
  'auditResponse',
  'auditFinding',
  'action',
  'actionHistory',
  'policyDocument',
  'policyVersion',
  'policyAcknowledgement',
  'risk',
  'registrationRecord',
  'regulatoryCorrespondence',
  'event',
  'eventTransition',
  'reportingObligation',
  'candourAssessment',
  'complaintDetail',
  'safeguardingCase',
  'premisesItem',
  'booking',
  'job',
  'patientContact',
  'shift',
  'crewAssignment',
  'resourceBooking',
  'jobAllocation',
  'allocationException',
  'jobStatusEvent',
  'shiftChange',
  'auditLog',
  'importBatch',
  'workbookItem',
] as const;

/** Columns never exported (credentials, push tokens, internal storage keys). */
const DROP = new Set(['pushToken', 'blobKey', 'idpSubject']);

const replacer = (k: string, v: unknown) =>
  DROP.has(k)
    ? undefined
    : typeof v === 'bigint'
      ? v.toString()
      : v instanceof Uint8Array
        ? Buffer.from(v).toString('base64')
        : v;

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export async function buildFullExport(
  tx: TenantTx,
  store: BlobStore,
  now: Date,
): Promise<{ zip: Uint8Array; tables: number; rows: number; attachments: number }> {
  const files: Record<string, Uint8Array> = {};
  const counts: Record<string, number> = {};
  let rows = 0;
  for (const t of TABLES) {
    const delegate = (
      tx as unknown as Record<string, { findMany: (a: object) => Promise<unknown[]> }>
    )[t];
    const data = await delegate!.findMany({});
    counts[snake(t)] = data.length;
    rows += data.length;
    files[`data/${snake(t)}.json`] = strToU8(JSON.stringify(data, replacer, 2));
  }
  const versions = await tx.evidenceVersion.findMany({
    where: { scanStatus: 'CLEAN', uploadedAt: { not: null } },
    select: { id: true, itemId: true, blobKey: true, mime: true, sha256: true },
  });
  const manifest = ['evidence_version_id,evidence_item_id,file,mime,sha256'];
  let attachments = 0;
  for (const v of versions) {
    const bytes = await store.get(v.blobKey);
    if (!bytes) continue;
    const ext =
      v.mime === 'application/pdf'
        ? 'pdf'
        : v.mime === 'image/png'
          ? 'png'
          : v.mime === 'image/jpeg'
            ? 'jpg'
            : 'bin';
    const name = `attachments/${v.id}.${ext}`;
    files[name] = new Uint8Array(bytes);
    manifest.push([v.id, v.itemId, name, v.mime ?? '', v.sha256 ?? ''].join(','));
    attachments += 1;
  }
  files['attachments/manifest.csv'] = strToU8(`${manifest.join('\r\n')}\r\n`);
  files['README.txt'] = strToU8(
    [
      'Healthcare Hub - full organisation export',
      `Generated: ${now.toISOString()}`,
      '',
      'data/<table>.json   every row you were permitted to see, one file per table',
      'attachments/        clean evidence files, named by evidence version id (see manifest.csv)',
      '',
      'IDs are stable UUIDs: rows reference each other by id across files.',
      'Times are UTC (ISO 8601); date-only fields are London dates.',
      'Fields encrypted at rest by the application (e.g. DBS certificate numbers) are exported as',
      'stored, encrypted; your organisation key holder can decrypt them.',
      'Push tokens, storage keys and identity-provider subjects are not exported.',
      '',
      `Rows per table: ${JSON.stringify(counts)}`,
    ].join('\n'),
  );
  return { zip: zipSync(files, { level: 6 }), tables: TABLES.length, rows, attachments };
}
