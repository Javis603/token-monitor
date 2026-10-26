export function activate(ctx) {
  return {
    renderTray(canvas, context) { const paint = canvas.getContext('2d'); paint.fillStyle = context.textColor || '#fff'; paint.fillRect(0, 0, canvas.width, canvas.height); },
    mount(container, context) {
      const label = document.createElement('p');
      label.textContent = `Trusted UI: ${context.viewId}`;
      const input = document.createElement('input');
      input.setAttribute('aria-label', 'Fixture draft');
      const output = document.createElement('output');
      const button = document.createElement('button');
      button.textContent = 'Call local backend';
      button.onclick = async () => { output.textContent = JSON.stringify(await ctx.backend.call('echo', input.value)); };
      container.append(label, input, button, output);
      const off = ctx.backend.subscribe(value => { output.dataset.update = String(value); });
      return {
        update(next) { label.textContent = `Trusted UI: ${next.viewId} (${next.width || 0})`; container.dataset.period = next.period || ''; container.dataset.source = next.source || ''; },
        hasUnsavedChanges: () => input.value.length > 0,
        dispose() { off(); container.replaceChildren(); }
      };
    }
  };
}
