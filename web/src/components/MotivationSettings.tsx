// Settings → Motivation & focus. Every extra is optional and off until you switch it on here.
import { useEffect, useState } from 'react';
import type { PrefKey } from '@shared/types';
import { setFocusSettings, useFocusSettings } from '../lib/focusSettings';
import { installApp, useInstallState } from '../lib/install';
import { setWorkerFastStart } from '../lib/notifications';
import { usePref } from '../lib/prefs';
import { disablePush, enablePush, pushConfigured, pushOnHere, pushSupported } from '../lib/push';
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
        <PrefSwitch k="streaks" label="Streaks">
          Counts days in a row you study at least 5 minutes, for you and your friend, on Home.
        </PrefSwitch>
        <PrefSwitch k="together" label="Study together live">
          When your friend starts studying, you'll get a gentle “join them?” nudge. Studying together shows a shared timer, and either of you can
          call a break for both.
        </PrefSwitch>
        <PrefSwitch k="challenge" label="Weekly challenge">
          Set a goal with your friend for the week, like 10 hours each. Win it together and a golden sunflower blooms in your shared forest.
        </PrefSwitch>
        <PrefSwitch k="photoCheers" label="Photo cheers 📸">
          Snap a selfie with your camera and send it to your friend, with a fun frame and a line. It floats around their study timer, then pins to
          the corner. Only the two of you see it, and it's deleted after 24 hours. Both of you need this on.
        </PrefSwitch>
        <PrefSwitch k="recap" label="Sunday recap">
          On Sunday (and Monday, looking back), a card sums up both your weeks: hours, best day, topics finished and trees planted.
        </PrefSwitch>
      </div>
      <PushCard />
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

function PushCard() {
  const [here, setHere] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const install = useInstallState();
  useEffect(() => {
    void pushOnHere().then(setHere);
  }, []);
  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (!on) {
        await disablePush();
        setHere(false);
        return;
      }
      const result = await enablePush();
      setHere(result === 'on');
      if (result === 'denied') toast('Notifications are blocked for this site. Allow them in your browser’s site settings, then try again.', 'error', 7000);
      if (result === 'on') toast('Notifications are on for this device 🔔', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Couldn’t turn on notifications.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card stack">
      <div>
        <h2>Phone notifications</h2>
        <p className="tiny muted">News from your friend, even when the app is closed. Choose what you hear about; it applies to every device you turn on.</p>
      </div>
      {!pushConfigured() ? (
        <p className="small muted">Not set up on this site yet.</p>
      ) : !pushSupported() ? (
        <p className="small muted">
          {install === 'ios'
            ? 'On iPhone, add the app to your Home Screen first (see “App on your phone” below), then open it from there and turn this on.'
            : 'This browser can’t receive notifications.'}
        </p>
      ) : (
        <Switch checked={Boolean(here)} onChange={(on) => !busy && void toggle(on)} label="Notifications on this device" />
      )}
      {pushConfigured() && (
        <>
          <PrefSwitch k="pushEncourage" label="Encouragement">
            When your friend sends a reaction, a note or a photo, or joins you to study together.
          </PrefSwitch>
          <PrefSwitch k="pushStudying" label="Your friend starts studying">
            A nudge to join them. Not while you're studying yourself, and only if they share their live status.
          </PrefSwitch>
          <PrefSwitch k="pushDayDone" label="Your friend finishes today's plan">
            When everything they planned for the day is done.
          </PrefSwitch>
        </>
      )}
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
