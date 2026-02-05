import { db } from '../lib/db';

// This makes the page dynamic so it fetches fresh data on every reload
export const dynamic = 'force-dynamic';

export default async function Home() {
  // 1. Fetch the last 10 analysis logs
  // If this fails, your DATABASE_URL in .env.local might be wrong
  let logs: any = { rows: [] };
  try {
      logs = await db.query(`
        SELECT 
          analysis_logs.id,
          repo_name,
          pr_number,
          decision,
          score,
          analysis_logs.created_at
        FROM analysis_logs
        JOIN installations ON analysis_logs.installation_id = installations.id
        ORDER BY analysis_logs.created_at DESC
        LIMIT 10
      `);
  } catch (error) {
      console.error("Database Error:", error);
      return <main className="p-10"><h1>❌ Database Connection Failed</h1><p>Check your terminal logs.</p></main>
  }

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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
            <h3 className="text-gray-500 text-sm font-medium">Total Scans</h3>
            <p className="text-3xl font-bold mt-2 text-black">{logs.rowCount || 0}</p>
          </div>
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
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {logs.rows.map((log: any) => (
                  <tr key={log.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 font-medium text-gray-900">{log.repo_name}</td>
                    <td className="px-6 py-4">#{log.pr_number}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
                        ${log.decision === 'APPROVE' ? 'bg-green-100 text-green-800' : 
                          log.decision === 'BLOCK' ? 'bg-red-100 text-red-800' : 
                          'bg-yellow-100 text-yellow-800'}`}>
                        {log.decision}
                      </span>
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
                  </tr>
                ))}
                {logs.rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-gray-400">
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