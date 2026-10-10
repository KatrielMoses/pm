import { Link } from '../router.tsx';
import { NotificationCentre } from '../notify/centre.tsx';
import { NotificationSettings } from '../notify/settings.tsx';
import { routeHref } from '../shell/registry.ts';
import { Page } from '../ui/layout.tsx';

/** 4B: the notification centre and the person's notification settings (fixed, mailed addresses). */

export function NotificationCentrePage({ ws }: { ws: string }) {
  return (
    <Page
      title="Notifications"
      wide
      actions={
        <Link className="button button-secondary" to={routeHref('notification_settings', { ws })}>
          Notification settings
        </Link>
      }
    >
      <NotificationCentre ws={ws} />
    </Page>
  );
}

export function NotificationSettingsPage({ ws }: { ws: string }) {
  return (
    <Page
      title="Notification settings"
      lead="Choose what reaches you, where, and when. These are your own choices; they don't change anyone else's."
    >
      <p>
        <Link to={routeHref('notifications', { ws })}>Back to your notifications</Link>
      </p>
      <NotificationSettings ws={ws} />
    </Page>
  );
}
