// 直接用 @electron/asar API 提取 package.json
async function main() {
  // dynamic import because @electron/asar is ESM
  const asar = await import('@electron/asar');
  const tmAsar = 'C:/Users/Neptune_yx/AppData/Local/Programs/token-monitor/Token Monitor/resources/app.asar';
  const buf = asar.extractFile(tmAsar, 'package.json');
  const pkg = JSON.parse(buf.toString('utf8'));
  console.log('当前 asar:');
  console.log('  name:', pkg.name);
  console.log('  version:', pkg.version);
  console.log('  main:', pkg.main);
}

main().catch(e => { console.error('err:', e.message); process.exit(1); });