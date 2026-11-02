export function ComingSoon({ title, milestone }: { title: string; milestone: string }) {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="text-slate-700">This module is built in Milestone {milestone}.</p>
    </div>
  );
}
