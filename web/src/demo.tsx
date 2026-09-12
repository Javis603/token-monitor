import { Dashboard } from './app';
import { statsFixture } from './test/fixtures';
// Synthetic fixture only. Demo mode never fetches Hub data or registers a worker.
const stats=structuredClone(statsFixture);
const now=new Date().toISOString();
for(const period of Object.values(stats.periods || {})) for(const session of Object.values(period.sessions || {})) session.lastUsedAt=now;
for(const provider of stats.limits!.providers!) {provider.updatedAt=now;for(const window of provider.windows || []) if(window.resetsAt) window.resetsAt=new Date(Date.now()+7200000).toISOString();}
stats.limits!.providers!.push({provider:'openrouter',status:'ok',updatedAt:now,balance:{amount:25,currency:'USD'},windows:[]});
export function Demo(){return <><aside class="demo-banner">Demo · Synthetic data</aside><Dashboard stats={stats} connection="live" source="network" savedAt={now}/></>;}
