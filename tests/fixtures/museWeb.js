'use strict';

// Shapes from CodexBar's MuseAIPluginTests at 897bff3 (MIT; see provider LICENSE).
const actionID = '40447f7d32b58c622904d92f8ac01a13f4798568bd';
const free = '1:{"success":true,"subscription":{"tier":{"name":"Muse Free"},"usage":{"percentUsed":28,"resetsAt":1790634838},"usageRowValueLabel":"28% used","agreement":null}}';
const paid = '0:{"a":"$@1"}\n1:{"success":true,"subscription":{"tier":{"name":"Maximum"},"usage":{"percentUsed":3,"resetsAt":1790634838},"usageRowValueLabel":"3% used (2.8B tokens left)","topupBalance":60000000,"topupTotal":80000000,"topupRowValueLabel":"25% used (1.5B tokens left)"}}';
const chunks = {
  '/': '<script src="/_next/static/chunks/app.js"></script><script src="/_next/static/chunks/loader.js"></script>',
  '/_next/static/chunks/app.js': 'e.A(434304).then(({preloadHatchSettingsData:e})=>e({}))',
  '/_next/static/chunks/loader.js': '},434304,s=>{s.v(t=>Promise.all(["static/chunks/settings.js"].map(t=>s.l(t))))}',
  '/_next/static/chunks/settings.js': `(0,d.createServerReference)("${actionID}",d.callServer,void 0,d.findSourceMapURL,"fetchSubscriptionAction")`
};
function fixtureFetch({ action = free, actionStatus = 200, onRequest = () => {} } = {}) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    onRequest(path, init);
    if (init.method === 'POST') {
      return init.headers['Next-Action'] === actionID
        ? new Response(action, { status: actionStatus })
        : new Response('Server action not found.', { status: 404 });
    }
    return new Response(chunks[path] || '', { status: 200 });
  };
}
module.exports = { actionID, free, paid, chunks, fixtureFetch };
