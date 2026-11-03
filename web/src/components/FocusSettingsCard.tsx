// Settings → Focus: optional timer controls in notifications, saved on this device.
import { useState } from 'react';
import { setFocusSettings, useFocusSettings } from '../lib/focusSettings';
import { notificationsSupported, notificationWorker } from '../lib/notifications';
import { Switch } from './ui';

export function FocusSettingsCard() {
  const settings = useFocusSettings();
  const [perm, setPerm] = useState(() => (notificationsSupported() ? Notification.permission : 'unsupported'));

  const toggleNotifications = async (on: boolean) => {
    if (!on) return setFocusSettings({ notificationControls: false });
    const result = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    setPerm(result);
    if (result !== 'granted') return;
    await notificationWorker();
    setFocusSettings({ notificationControls: true });
  };

  return (
    <div className="card stack">
      <div>
        <h2>Focus</h2>
        <p className="tiny muted">Saved on this device only. Optional; the timer works the same with it off.</p>
      </div>
      {perm === 'unsupported' ? (
        <p className="tiny muted">This browser can't show timer notifications (for example Safari on iPhone).</p>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          <Switch checked={settings.notificationControls && perm === 'granted'} onChange={(on) => void toggleNotifications(on)} label="Timer controls in notifications" />
          <p className="tiny muted">
            {perm === 'denied'
              ? 'Notifications are blocked for this site. Allow them in your browser’s site settings, then turn this on.'
              : 'When you leave the app during a session, a notification shows the topic with Pause / Resume. It disappears when you come back.'}
          </p>
        </div>
      )}
    </div>
  );
}
