import { db } from '../../lib/db';
import Link from 'next/link';
import { getServerSession } from "next-auth/next";
import { authOptions } from "../../lib/auth";
import SettingsForm from './SettingsForm';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await getServerSession(authOptions);
  
  if (!session) {
    return null; 
  }
  
  const installationIds = (session as any).installationIds || [];
  
  if (installationIds.length === 0) {
    return (
      <main className="min-h-screen bg-gray-50 p-8 flex items-center justify-center">
        <div className="text-center bg-white p-10 rounded-xl shadow-sm border border-gray-100">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">No Installations Found</h2>
          <p className="text-gray-600 mb-4">We couldn't find any FeaturePulse installations linked to your GitHub account.</p>
        </div>
      </main>
    );
  }

  let installations = [];
  try {
    const result = await db.query(
      `SELECT github_installation_id, repo_name, mode FROM installations WHERE github_installation_id = ANY($1) ORDER BY repo_name ASC`,
      [installationIds]
    );
    installations = result.rows;
  } catch (error) {
    console.error("Database Error:", error);
    return <main className="p-10"><h1>❌ Database Connection Failed</h1></main>;
  }

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Settings</h1>
          <Link href="/" className="px-4 py-2 bg-white text-gray-700 border border-gray-200 rounded-md hover:bg-gray-50 text-sm font-medium">
            Back to Dashboard
          </Link>
        </div>
        
        {installations.map((inst: any) => (
          <SettingsForm 
            key={inst.github_installation_id}
            installationId={inst.github_installation_id}
            repoName={inst.repo_name}
            initialMode={inst.mode || 'gatekeeper'}
          />
        ))}
        
        {installations.length === 0 && (
          <p className="text-gray-500 text-center mt-10">No repositories found for these installations.</p>
        )}
      </div>
    </main>
  );
}
