import { db } from '../lib/db';
import Link from 'next/link';
import { getServerSession } from "next-auth/next";
import { authOptions } from "../lib/auth";

// This makes the page dynamic so it fetches fresh data on every reload
export const dynamic = 'force-dynamic';

function formatMergeTime(seconds: number | null) {
  if (seconds === null) return '-';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams;
  const decisionFilter = typeof params.decision === 'string' ? params.decision : null;

  const session = await getServerSession(authOptions);
  
  if (!session) {
    return null; // Middleware will redirect to login
  }
  
  const installationIds = (session as any).installationIds || [];
  
  if (installationIds.length === 0) {
    return (
      <main className="min-h-screen bg-gray-50 p-8 flex items-center justify-center">
        <div className="text-center bg-white p-10 rounded-xl shadow-sm border border-gray-100">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">No Installations Found</h2>
          <p className="text-gray-600 mb-4">We couldn't find any FeaturePulse installations linked to your GitHub account.</p>
          <p className="text-sm text-gray-500">If you just installed the app, please <Link href="/api/auth/signout" className="text-blue-600 hover:underline">sign out</Link> and sign back in.</p>
        </div>
      </main>
    );
  }

  let stats: any = { rowCount: 0, rows: [] };
  let logs: any = { rowCount: 0, rows: [] };
  
  try {
    const statsQuery = `
      SELECT 
        COUNT(*) as total_scans,
        AVG(score) as avg_score,
        SUM(CASE WHEN decision = 'APPROVE' THEN 1 ELSE 0 END) as approve_count,
        SUM(CASE WHEN decision = 'BLOCK' THEN 1 ELSE 0 END) as block_count,
        SUM(CASE WHEN decision = 'WARN' THEN 1 ELSE 0 END) as warn_count,
        SUM(CASE WHEN human_override = true THEN 1 ELSE 0 END) as override_count
      FROM analysis_logs
      WHERE installation_id = ANY($1)
    `;
    
    let listQuery = `
      SELECT 
        analysis_logs.id,
        repo_name,
        pr_number,
        decision,
        score,
        analysis_logs.created_at,
        human_override,
        time_to_merge,
        used_intent_file
      FROM analysis_logs
      JOIN installations ON analysis_logs.installation_id = installations.id
      WHERE analysis_logs.installation_id = ANY($1)
    `;
    
    const queryParams: any[] = [installationIds];
    if (decisionFilter) {
      listQuery += ` AND decision = $2`;
      queryParams.push(decisionFilter);
    }
    
    listQuery += ` ORDER BY analysis_logs.created_at DESC LIMIT 10`;

    // Run both queries in parallel
    [stats, logs] = await Promise.all([
      db.query(statsQuery, [installationIds]),
      db.query(listQuery, queryParams)
    ]);
    
  } catch (error) {
    console.error("Database Error:", error);
    return <main className="p-10"><h1>❌ Database Connection Failed</h1><p>Check your terminal logs.</p></main>
  }

  const statData = stats.rows[0] || {};
  const totalScans = parseInt(statData.total_scans) || 0;
  const avgScore = statData.avg_score ? Math.round(parseFloat(statData.avg_score)) : 0;
  const blockCount = parseInt(statData.block_count) || 0;
  const overrideCount = parseInt(statData.override_count) || 0;
  // Calculate override rate specifically against BLOCK decisions
  const overrideRate = blockCount > 0 ? Math.round((overrideCount / blockCount) * 100) : 0;

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">FeaturePulse Dashboard</h1>
          <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm font-medium">
            🟢 System Online
          </span>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-8">
          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
            <h3 className="text-gray-500 text-sm font-medium">Total Scans</h3>
            <p className="text-3xl font-bold mt-2 text-black">{totalScans}</p>
          </div>
          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
            <h3 className="text-gray-500 text-sm font-medium">Average Score</h3>
            <p className="text-3xl font-bold mt-2 text-black">{avgScore}</p>
          </div>
          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
            <h3 className="text-gray-500 text-sm font-medium">Decisions</h3>
            <div className="mt-2 flex gap-2 text-sm font-medium">
              <span className="text-green-600">{statData.approve_count || 0} A</span>
              <span className="text-red-600">{statData.block_count || 0} B</span>
              <span className="text-yellow-600">{statData.warn_count || 0} W</span>
            </div>
          </div>
          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
            <h3 className="text-gray-500 text-sm font-medium">Override Rate</h3>
            <p className="text-3xl font-bold mt-2 text-black">{overrideRate}%</p>
            <p className="text-xs text-gray-400 mt-1">of BLOCK decisions</p>
          </div>
        </div>

        {/* Filters */}
        <div className="mb-4 flex gap-2">
          <Link href="/" className={`px-3 py-1.5 rounded-md text-sm font-medium ${!decisionFilter ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'}`}>All</Link>
          <Link href="/?decision=APPROVE" className={`px-3 py-1.5 rounded-md text-sm font-medium ${decisionFilter === 'APPROVE' ? 'bg-green-600 text-white' : 'bg-white text-green-700 border border-gray-200 hover:bg-green-50'}`}>Approve</Link>
          <Link href="/?decision=BLOCK" className={`px-3 py-1.5 rounded-md text-sm font-medium ${decisionFilter === 'BLOCK' ? 'bg-red-600 text-white' : 'bg-white text-red-700 border border-gray-200 hover:bg-red-50'}`}>Block</Link>
          <Link href="/?decision=WARN" className={`px-3 py-1.5 rounded-md text-sm font-medium ${decisionFilter === 'WARN' ? 'bg-yellow-500 text-white' : 'bg-white text-yellow-700 border border-gray-200 hover:bg-yellow-50'}`}>Warn</Link>
        </div>

        {/* Recent Activity Table */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-lg font-semibold text-gray-900">Recent Activity</h2>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-gray-600">
              <thead className="bg-gray-50 text-gray-900 font-medium">
                <tr>
                  <th className="px-6 py-3">Repository</th>
                  <th className="px-6 py-3">PR #</th>
                  <th className="px-6 py-3">Decision</th>
                  <th className="px-6 py-3">Score</th>
                  <th className="px-6 py-3">Time</th>
                  <th className="px-6 py-3">Merge Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {logs.rows.map((log: any) => (
                  <tr key={log.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 font-medium text-gray-900">
                      <div className="flex items-center gap-2">
                        {log.repo_name}
                        {log.used_intent_file && <span title="Used intent.md file" className="text-gray-400">📄</span>}
                      </div>
                    </td>
                    <td className="px-6 py-4">#{log.pr_number}</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
                          ${log.decision === 'APPROVE' ? 'bg-green-100 text-green-800' : 
                            log.decision === 'BLOCK' ? 'bg-red-100 text-red-800' : 
                            'bg-yellow-100 text-yellow-800'}`}>
                          {log.decision}
                        </span>
                        {log.human_override && <span title="Human Overridden" className="text-red-500 font-bold text-xs">⚠️ Overridden</span>}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center">
                        <span className="mr-2">{log.score}/100</span>
                        <div className="w-16 bg-gray-200 rounded-full h-1.5">
                          <div 
                            className={`h-1.5 rounded-full ${log.score > 80 ? 'bg-green-500' : 'bg-yellow-500'}`} 
                            style={{ width: `${log.score}%` }}
                          ></div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-gray-400">
                      {new Date(log.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 text-gray-500 font-mono">
                      {formatMergeTime(log.time_to_merge)}
                    </td>
                  </tr>
                ))}
                {logs.rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-8 text-center text-gray-400">
                      No analysis logs found yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>
  );
}