import { IntegrationsPanel } from '../integrations/panel.tsx';
import { Page } from '../ui/layout.tsx';

/** Workspace and brand connections (6A). Credentials are never shown after they are saved. */
export function IntegrationsPage({ ws }: { ws: string }) {
  return (
    <Page
      title="Integrations"
      lead="Connections, who owns them, what they may do, and when they last synchronized."
    >
      <IntegrationsPanel ws={ws} />
    </Page>
  );
}
