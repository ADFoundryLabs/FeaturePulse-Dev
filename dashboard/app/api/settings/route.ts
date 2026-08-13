import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/db';

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { installationId, mode } = await req.json();

    if (!installationId || !['gatekeeper', 'advisory', 'silent'].includes(mode)) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }

    const allowedInstallationIds = (session as any).installationIds || [];

    const hasAccess = allowedInstallationIds.some(
      (id: number | string) => String(id) === String(installationId)
    );

    if (!hasAccess) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await db.query(
      `UPDATE installations SET mode=$1 WHERE github_installation_id=$2`,
      [mode, installationId]
    );
    
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error updating installation mode:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
