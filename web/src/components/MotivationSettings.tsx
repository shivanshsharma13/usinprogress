// Settings → Motivation & focus. Every extra is optional and off until you switch it on here.
import type { PrefKey } from '@shared/types';
import { setFocusSettings, useFocusSettings } from '../lib/focusSettings';
import { installApp, useInstallState } from '../lib/install';
import { setWorkerFastStart } from '../lib/notifications';
import { usePref } from '../lib/prefs';
import { toast } from '../lib/toast';
import { Switch } from './ui';
import { FocusSettingsCard } from './FocusSettingsCard';

export function MotivationSettings() {
  return (
    <div className="stack-lg">
      <div className="card stack">
        <div>
          <h2>Motivation</h2>
          <p className="tiny muted">Saved to your account, so they follow you to every device. Turning one off hides it; nothing is deleted.</p>
        </div>
        <PrefSwitch k="revisions" label="Revision reminders">
          After you finish a topic, it comes back to revise 1, 3, 7 and 21 days later, on Home and in the room's Today.
        </PrefSwitch>
      </div>
      <FocusSettingsCard />
      <InstallCard />
    </div>
  );
}

function PrefSwitch({ k, label, children }: { k: PrefKey; label: string; children: React.ReactNode }) {
  const [on, set] = usePref(k);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <Switch checked={on} onChange={set} label={label} />
      <p className="tiny muted">{children}</p>
    </div>
  );
}

function InstallCard() {
  const install = useInstallState();
  const { fastStart } = useFocusSettings();
  return (
    <div className="card stack">
      <div>
        <h2>App on your phone</h2>
        <p className="tiny muted">Put Us in Progress on your home screen. It opens full-screen, like any other app.</p>
      </div>
      {install === 'installed' && <p className="small">✓ Installed on this device.</p>}
      {install === 'ready' && (
        <div>
          <button className="btn primary" onClick={() => void installApp().then((ok) => ok && toast('Installed — look for it on your home screen 🌱', 'success'))}>
            Install app
          </button>
        </div>
      )}
      {install === 'ios' && (
        <p className="small">
          In Safari, tap <b>Share</b> <span aria-hidden="true">⎋</span> then <b>Add to Home Screen</b>.
        </p>
      )}
      {install === 'unavailable' && (
        <p className="small muted">Open this page in Chrome on Android (menu ⋮ → Install app) or Safari on iPhone (Share → Add to Home Screen).</p>
      )}
      <div className="stack" style={{ gap: 6 }}>
        <Switch
          checked={fastStart}
          onChange={(on) => {
            setFocusSettings({ fastStart: on });
            void setWorkerFastStart(on);
          }}
          label="Fast start on this device"
        />
        <p className="tiny muted">
          Keeps the app's own files on this device, so it opens quickly on a weak connection and shows your last screens offline. Your study data always
          comes fresh from the server.
        </p>
      </div>
    </div>
  );
}
