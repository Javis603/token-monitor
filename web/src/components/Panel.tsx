import { usePreferences } from '../preferences';
import type { ComponentChildren } from 'preact';

interface PanelProps {
  title: string;
  eyebrow?: string;
  className?: string;
  children: ComponentChildren;
}

export function Panel({ title, eyebrow, className = '', children }: PanelProps) {
  const {t} = usePreferences();
  return (
    <section class={`panel ${className}`.trim()}>
      <header class="panel__header">
        <div>
          {eyebrow && <p class="eyebrow">{t(eyebrow)}</p>}
          <h2>{t(title)}</h2>
        </div>
      </header>
      <div class="panel__body">{children}</div>
    </section>
  );
}
