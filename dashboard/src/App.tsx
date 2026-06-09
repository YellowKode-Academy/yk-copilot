import { useEffect, useState } from 'react';

type Session = {
  id: string;
  firstMsg: string;
  startedAt: string;
  lastActivity: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  models: string[];
};

type Stats = {
  totalSessions: number;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalToolCalls: number;
  modelFast: string;
  modelSmart: string;
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-5 py-4">
      <div className="text-zinc-500 text-xs uppercase tracking-widest mb-1">{label}</div>
      <div className="text-yellow-400 text-2xl font-bold">{typeof value === 'number' ? fmt(value) : value}</div>
    </div>
  );
}

function ModelBadge({ name, fast }: { name: string; fast: boolean }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-bold ${fast ? 'bg-zinc-700 text-zinc-300' : 'bg-yellow-400/20 text-yellow-400'}`}>
      {fast ? 'FAST' : 'SMART'}
    </span>
  );
}

function SessionCard({ session, modelFast }: { session: Session; modelFast: string }) {
  const isFast  = session.models.includes(modelFast) && session.models.length === 1;
  const isSmart = session.models.some(m => m !== modelFast);
  const isMixed = session.models.includes(modelFast) && isSmart;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-5 py-4 hover:border-zinc-600 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <p className="text-white text-sm leading-snug line-clamp-2 flex-1">{session.firstMsg}</p>
        <span className="text-zinc-500 text-xs whitespace-nowrap shrink-0">{timeAgo(session.lastActivity)}</span>
      </div>
      <div className="flex items-center gap-3 mt-3 flex-wrap">
        <span className="text-zinc-400 text-xs">{session.requests} {session.requests === 1 ? 'request' : 'requests'}</span>
        <span className="text-zinc-700">·</span>
        <span className="text-zinc-400 text-xs">{fmt(session.inputTokens + session.outputTokens)} tokens</span>
        {session.toolCalls > 0 && (
          <>
            <span className="text-zinc-700">·</span>
            <span className="text-zinc-400 text-xs">{session.toolCalls} tool {session.toolCalls === 1 ? 'call' : 'calls'}</span>
          </>
        )}
        <span className="text-zinc-700">·</span>
        {isMixed ? (
          <><ModelBadge name={modelFast} fast={true} /><ModelBadge name="" fast={false} /></>
        ) : isFast ? (
          <ModelBadge name={modelFast} fast={true} />
        ) : (
          <ModelBadge name="" fast={false} />
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [stats, setStats]       = useState<Stats | null>(null);
  const [live, setLive]         = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const [s, st] = await Promise.all([
          fetch('/api/sessions').then(r => r.json()),
          fetch('/api/stats').then(r => r.json()),
        ]);
        setSessions(s);
        setStats(st);
        const recentActivity = s.some((x: Session) => Date.now() - new Date(x.lastActivity).getTime() < 10000);
        setLive(recentActivity);
      } catch {}
    };
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-yellow-400 font-bold text-lg tracking-tight">YK</span>
          <span className="text-white font-bold text-lg tracking-tight">COPILOT</span>
          <span className={`w-2 h-2 rounded-full ${live ? 'bg-green-400 animate-pulse' : 'bg-zinc-700'}`} title={live ? 'Active' : 'Idle'} />
        </div>
        {stats && (
          <div className="hidden sm:flex items-center gap-4 text-xs text-zinc-500">
            <span>fast: <span className="text-zinc-300">{stats.modelFast}</span></span>
            <span className="text-zinc-700">·</span>
            <span>smart: <span className="text-zinc-300">{stats.modelSmart}</span></span>
          </div>
        )}
      </header>

      <main className="max-w-5xl mx-auto px-6 py-6 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <StatCard label="Sessions"      value={stats?.totalSessions     ?? 0} />
          <StatCard label="Requests"      value={stats?.totalRequests     ?? 0} />
          <StatCard label="Input tokens"  value={stats?.totalInputTokens  ?? 0} />
          <StatCard label="Output tokens" value={stats?.totalOutputTokens ?? 0} />
          <StatCard label="Tool calls"    value={stats?.totalToolCalls    ?? 0} />
        </div>

        {/* Model routing legend */}
        {stats && (
          <div className="flex items-center gap-4 text-xs text-zinc-600">
            <span><span className="text-zinc-400 font-bold">FAST</span> = {stats.modelFast} — used for simple, short requests</span>
            <span className="text-zinc-800">·</span>
            <span><span className="text-yellow-500 font-bold">SMART</span> = {stats.modelSmart} — used for complex, multi-turn requests</span>
          </div>
        )}

        {/* Sessions */}
        <div>
          <h2 className="text-zinc-500 text-xs uppercase tracking-widest mb-3">Sessions</h2>
          {sessions.length === 0 ? (
            <div className="text-center py-16 text-zinc-700 text-sm">
              <p>No sessions yet.</p>
              <p className="mt-2 text-zinc-800">Set <span className="text-zinc-600">ANTHROPIC_BASE_URL=http://localhost:9999</span> and start Claude Code.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {sessions.map(s => (
                <SessionCard key={s.id} session={s} modelFast={stats?.modelFast ?? ''} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
