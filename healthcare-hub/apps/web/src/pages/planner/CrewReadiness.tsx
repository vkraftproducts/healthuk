import { StatusBadge, type StatusKind } from '@hub/ui';
import { words } from '../../components.js';
import { useOne } from '../settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const READINESS: Record<string, { status: StatusKind; word: string }> = {
  READY: { status: 'GREEN', word: 'Ready' },
  RESTRICTED: { status: 'AMBER', word: 'Restricted' },
  BLOCKED: { status: 'RED', word: 'Not ready' },
};

/** E2: readiness for each person as they are picked, with the reasons in words. */
export function CrewReadiness(p: {
  staffId: string;
  name: string;
  role: string;
  window: { from: string; to: string };
  vehicleId?: string;
}) {
  const q = new URLSearchParams({
    staffId: p.staffId,
    role: p.role,
    from: p.window.from,
    to: p.window.to,
    ...(p.vehicleId ? { vehicleId: p.vehicleId } : {}),
  });
  const res = useOne<Row>(`/api/v1/shifts/crew-readiness?${q}`);
  if (res.isLoading) return <p className="text-sm">Checking {p.name}…</p>;
  if (res.isError || !res.data)
    return <p className="text-sm">Readiness for {p.name} could not be checked.</p>;
  const state = READINESS[res.data.state as string] ?? { status: 'GREY', word: 'Unknown' };
  const problems = ((res.data.checks ?? []) as Row[]).filter((c) => c.result !== 'PASS');
  return (
    <div className="text-sm" role="group" aria-label={`Readiness of ${p.name}`}>
      {p.name} ({words(p.role)}): <StatusBadge status={state.status} reason={state.word} />
      {problems.length > 0 && (
        <ul className="ml-4 list-disc">
          {problems.map((c) => (
            <li key={c.code}>{c.reasonText}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
