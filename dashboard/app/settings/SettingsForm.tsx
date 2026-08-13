'use client';

import { useState } from 'react';

export default function SettingsForm({
  installationId,
  repoName,
  initialMode
}: {
  installationId: number,
  repoName: string,
  initialMode: string
}) {
  const [mode, setMode] = useState(initialMode);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const saveMode = async (newMode: string) => {
    setMode(newMode);
    setLoading(true);
    setMessage('');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId, mode: newMode })
      });
      if (!res.ok) throw new Error('Failed to save');
      setMessage('Saved');
      setTimeout(() => setMessage(''), 2000);
    } catch (e) {
      setMessage('Error saving');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 mb-6">
      <h2 className="text-xl font-semibold text-gray-900 mb-4">{repoName}</h2>
      
      <div className="space-y-4">
        <label className="flex items-start cursor-pointer group">
          <div className="flex items-center h-5">
            <input 
              type="radio" 
              name={`mode-${installationId}`} 
              value="gatekeeper"
              checked={mode === 'gatekeeper'}
              onChange={(e) => saveMode(e.target.value)}
              className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
            />
          </div>
          <div className="ml-3 text-sm">
            <span className="font-medium text-gray-900 block group-hover:text-blue-600 transition-colors">Gatekeeper</span>
            <span className="text-gray-500">AI verdict enforced as-is (default)</span>
          </div>
        </label>
        
        <label className="flex items-start cursor-pointer group">
          <div className="flex items-center h-5">
            <input 
              type="radio" 
              name={`mode-${installationId}`} 
              value="advisory"
              checked={mode === 'advisory'}
              onChange={(e) => saveMode(e.target.value)}
              className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
            />
          </div>
          <div className="ml-3 text-sm">
            <span className="font-medium text-gray-900 block group-hover:text-blue-600 transition-colors">Advisory</span>
            <span className="text-gray-500">Never blocks; BLOCK verdicts are downgraded to WARN on the check run</span>
          </div>
        </label>

        <label className="flex items-start cursor-pointer group">
          <div className="flex items-center h-5">
            <input 
              type="radio" 
              name={`mode-${installationId}`} 
              value="silent"
              checked={mode === 'silent'}
              onChange={(e) => saveMode(e.target.value)}
              className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
            />
          </div>
          <div className="ml-3 text-sm">
            <span className="font-medium text-gray-900 block group-hover:text-blue-600 transition-colors">Silent</span>
            <span className="text-gray-500">Logs analysis but posts no check run or comment</span>
          </div>
        </label>
      </div>
      
      <div className="mt-4 text-sm min-h-[20px]">
        {loading && <span className="text-gray-500">Saving...</span>}
        {message && <span className={message === 'Saved' ? 'text-green-600' : 'text-red-600'}>{message}</span>}
      </div>
    </div>
  );
}
