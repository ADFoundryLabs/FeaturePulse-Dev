const { Redis } = require('ioredis');
require('dotenv').config({ path: 'c:\\Users\\user\\Documents\\GitHub\\FeaturePulse-Dev\\.env' });
const redis = new Redis(process.env.REDIS_URL);
async function run() {
  const wait = await redis.lrange('bull:pr-analysis:wait', 0, -1);
  const active = await redis.lrange('bull:pr-analysis:active', 0, -1);
  const failed = await redis.zrange('bull:pr-analysis:failed', 0, -1);
  console.log('Waiting:', wait);
  console.log('Active:', active);
  console.log('Failed:', failed);
  process.exit(0);
}
run().catch(console.error);
