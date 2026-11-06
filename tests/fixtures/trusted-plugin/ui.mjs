export function activate(ctx) {
  return {
    renderTray(canvas, context) { const paint = canvas.getContext('2d'); paint.fillStyle = context.textColor || '#fff'; paint.fillRect(0, 0, canvas.width, canvas.height); },
    mount(container, context) {
      if (context.surfaceVariant === 'summary') {
        container.style.cssText='display:flex;align-items:center;gap:8px;height:24px;white-space:nowrap';
        const label=document.createElement('span');label.textContent='作者摘要';
        const input=document.createElement('input');input.setAttribute('aria-label','Fixture draft');input.style.cssText='width:100px;min-width:0;height:22px;box-sizing:border-box';input.placeholder='可輸入';
        const output=document.createElement('output');
        container.append(label,input,output);
        const off=ctx.backend.subscribe(value=>{output.dataset.update=String(value);output.textContent=String(value);});
        return {update(){},dispose(){off();container.replaceChildren();}};
      }
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
