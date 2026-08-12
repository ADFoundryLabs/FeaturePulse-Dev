import { Webhooks } from '@octokit/webhooks';

const webhooks = new Webhooks({
  secret: 'test',
});

webhooks.on('pull_request.opened', async ({ payload }) => {
  console.log('✅ Handler matched! Action:', payload.action);
});

webhooks.on('any', (event) => {
  console.log('🔔 ANY event triggered:', event.name);
});

const payload = JSON.stringify({ action: 'opened', pull_request: { number: 18 } });

async function test() {
  const signature = await webhooks.sign(payload);
  console.log('Signature:', signature);
  
  try {
    await webhooks.verifyAndReceive({
      id: '123',
      name: 'pull_request',
      payload: payload,
      signature: signature,
    });
    console.log('VerifyAndReceive complete.');
  } catch (err) {
    console.error('Error:', err.message);
  }
}

test();
