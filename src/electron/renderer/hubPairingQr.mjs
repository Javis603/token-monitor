import qrcode from '../../../node_modules/qrcode-generator/dist/qrcode.mjs';

export function drawHubPairingQr(canvas, url, secret) {
  if (!secret || secret.length > 512 || /[\u0000-\u001f\u007f]/.test(secret)) {
    throw new Error('Invalid Hub secret');
  }
  const payload = JSON.stringify({ type: 'token-monitor-hub', version: 1, url, secret })
    .replace(/[^\x00-\x7f]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  const qr = qrcode(0, 'M');
  qr.addData(payload, 'Byte');
  qr.make();

  const modules = qr.getModuleCount();
  const scale = 6;
  const margin = 4;
  canvas.width = canvas.height = (modules + 2 * margin) * scale;
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000';
  for (let row = 0; row < modules; row++) {
    for (let column = 0; column < modules; column++) {
      if (qr.isDark(row, column)) context.fillRect((column + margin) * scale, (row + margin) * scale, scale, scale);
    }
  }
}
